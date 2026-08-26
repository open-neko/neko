import type { WorkflowRunFirePayload } from "@neko/db/jobs";
import {
  ensureHostConfigProvisioned,
  type AgentEvent,
  registerAgentCanceller,
} from "@neko/llm";
import {
  appendWorkRunEvent,
  ensureAgentBroker,
  registerAgentBrokerEventSink,
  scrubAgentEvent,
  workflowRuntimeDepsFromEnv,
} from "@neko/llm/work";
import {
  claimWorkflowScheduleFiring,
  completeWorkflowScheduleFiring,
  linkWorkflowScheduleFiringRun,
  prepareWorkflowRun,
  releaseWorkflowScheduleFiringRun,
  runWorkflowTurn,
} from "@neko/llm/workflows";
import {
  getCurrentScrubber,
  getPluginRegistryInstance,
} from "../plugins/registry-instance.js";
import { includeRecordActionDescriptors } from "../records/adapters.js";

// Thrown when worker shutdown cuts a headless run short, so the pg-boss handler
// fails the job and a later worker retries it.
export class WorkflowRunInterrupted extends Error {
  constructor() {
    super("Workflow run interrupted by worker shutdown");
    this.name = "WorkflowRunInterrupted";
  }
}

export async function runWorkflowRunFire(
  payload: WorkflowRunFirePayload,
): Promise<void> {
  const scheduleFiringId = payload.scheduleFiringId;
  if (scheduleFiringId) {
    const claimed = await claimWorkflowScheduleFiring({
      firingId: scheduleFiringId,
      orgId: payload.orgId,
      workflowId: payload.workflowId,
    });
    if (!claimed) {
      console.log(
        `[workflow-run-fire] duplicate delivery ignored firing=${scheduleFiringId}`,
      );
      return;
    }
  }

  let workflowFinished = false;
  try {
    await ensureHostConfigProvisioned(payload.orgId);

    const prepared = await prepareWorkflowRun({
      orgId: payload.orgId,
      workflowId: payload.workflowId,
      triggerKind: payload.triggerKind,
      triggerPayload: payload.triggerPayload,
      threadId: payload.threadId,
      parentChainDepth: payload.parentChainDepth,
      triggeredBySubscriptionId: payload.triggeredBySubscriptionId,
      triggeredByOutputId: payload.triggeredByOutputId,
      triggeredByObservationId: payload.triggeredByObservationId,
    });
    if (scheduleFiringId) {
      await linkWorkflowScheduleFiringRun(
        scheduleFiringId,
        prepared.workflowRun.id,
      );
    }

    // Scrubber snapshot per fire — see work-run.ts for the
    // mid-run-rotation caveat.
    const scrubber = getCurrentScrubber();
    const emit = async (event: AgentEvent): Promise<void> => {
      await appendWorkRunEvent({
        orgId: payload.orgId,
        threadId: prepared.threadId,
        runId: prepared.workRunId,
        event: scrubAgentEvent(scrubber, event),
      });
    };

    const pluginActions = includeRecordActionDescriptors(
      getPluginRegistryInstance()?.getRegisteredActionDescriptors() ?? [],
    );

    const broker = await ensureAgentBroker();

    // SIGTERM aborts this signal, so an interrupted run finalizes as "cancelled"
    // (not a hard failure with an opaque "ACP client disposed" error).
    const abort = new AbortController();
    const unregister = registerAgentCanceller(() => abort.abort());
    const unregisterBrokerEvents = registerAgentBrokerEventSink(
      prepared.workRunId,
      emit,
    );
    let result;
    try {
      result = await runWorkflowTurn(
        {
          prepared,
          userMessage: payload.userMessage,
          mode: "headless",
          emit,
          signal: abort.signal,
          pluginActions,
        },
        workflowRuntimeDepsFromEnv(broker),
      );
    } finally {
      unregisterBrokerEvents();
      unregister();
    }

    if (result.status === "cancelled") throw new WorkflowRunInterrupted();
    workflowFinished = true;
    if (scheduleFiringId) {
      await completeWorkflowScheduleFiring(scheduleFiringId);
    }
  } catch (error) {
    if (scheduleFiringId && !workflowFinished) {
      await releaseWorkflowScheduleFiringRun(scheduleFiringId, error).catch(
        (releaseError) => {
          console.error(
            `[workflow-run-fire] could not release firing=${scheduleFiringId}: ${releaseError instanceof Error ? releaseError.message : releaseError}`,
          );
        },
      );
    }
    throw error;
  }
}
