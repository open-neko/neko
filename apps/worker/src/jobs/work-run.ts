import type { AgentEvent } from "@neko/llm";
import {
  agentRuntimeDepsFromEnv,
  appendWorkRunEvent,
  ensureAgentBroker,
  getWorkRun,
  runChatTurn,
  scrubAgentEvent,
  type RunChannel,
} from "@neko/llm/work";
import {
  getCurrentScrubber,
  getPluginRegistryInstance,
} from "../plugins/registry-instance.js";
import { deliverChatReply } from "../channels/delivery.js";

export async function runWorkRun(
  _jobId: string,
  orgId: string,
  payload: {
    runId: string;
    threadId: string;
    message: string;
    channel?: RunChannel;
    channelPlugin?: string;
    recipient?: Record<string, unknown>;
  },
): Promise<void> {
  const { runId, threadId, message, channel, channelPlugin, recipient } =
    payload;

  const run = await getWorkRun(orgId, runId);
  if (!run) {
    console.warn(
      `[work-run] run ${runId} not found for thread ${threadId}; skipping stale job`,
    );
    return;
  }

  // Snapshot the scrubber once per run. fs.watch on the secrets file
  // rebuilds the registry's scrubber, so a future run picks up rotated
  // values; mid-run rotation is documented as out-of-scope.
  const scrubber = getCurrentScrubber();

  // A channel-initiated run has no SSE stream, so the agent's a2ui surface(s)
  // would be lost. Collect the (scrubbed) surface messages here so the reply
  // can carry them to channels that render rich content (e.g. Telegram).
  const surfaces: unknown[] = [];
  // The agent reliably emits a `vitals` fence (mandatory) but not always an a2ui
  // surface; collect the vitals so the reply can render them as cards on a
  // channel even when no surface was produced.
  let vitals: { label: string; value: string; sub?: string }[] = [];
  const emit = async (event: AgentEvent): Promise<void> => {
    const scrubbed = scrubAgentEvent(scrubber, event);
    if (scrubbed.type === "surface" && Array.isArray(scrubbed.messages)) {
      surfaces.push(...scrubbed.messages);
    }
    if (scrubbed.type === "vitals" && Array.isArray(scrubbed.items)) {
      vitals = scrubbed.items;
    }
    await appendWorkRunEvent({ orgId, threadId, runId, event: scrubbed });
  };

  const pluginActions =
    getPluginRegistryInstance()?.getRegisteredActionDescriptors() ?? [];

  const broker = await ensureAgentBroker();

  const result = await runChatTurn(
    {
      orgId,
      threadId,
      runId,
      message,
      channel,
      emit,
      pluginActions,
    },
    agentRuntimeDepsFromEnv(broker),
  );

  // Channel-initiated runs have no other return path — send the reply back to
  // the sender. Web runs (no channelPlugin) stream over SSE instead.
  if (channelPlugin && recipient && result.status === "completed") {
    await deliverChatReply(orgId, channelPlugin, recipient, runId, result.finalText, surfaces, vitals);
  }
}
