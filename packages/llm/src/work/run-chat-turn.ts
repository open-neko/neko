import {
  data_source,
  db,
  desc,
  eq,
  getGraphjinConfigSettingsForOrg,
} from "@neko/db";
import type { AgentChatMessage, AgentEvent } from "../agent-backend";
import { resolveAgentBackend as defaultResolveAgentBackend } from "../agent-backend-resolver";
import { normalizeGraphjinAgentUsage } from "../usage-normalization";
import { extractMemoryFences } from "../agent-backends/memory-fence";
import {
  extractActionRequestFences,
  extractFollowupsFence,
  extractRuleSaveFence,
  extractValueFence,
  extractVitalsFence,
  extractWorkflowSaveFence,
} from "../workflows/fence-parsers";
import { clampAnalysisMinutes } from "../workflows/value";
import {
  handleWorkActionRequest,
  policySavedCard,
  saveWorkflowWithTrigger,
  subscriptionSavedCard,
  upsertActionPolicyByName,
  workflowSavedCard,
  type ActionPolicyMode,
  type ActionScope,
  type RiskLevel,
} from "../workflows";
import {
  knowledgePackPaths,
  prefetchKnowledgeForOrg as defaultPrefetchKnowledgeForOrg,
  readKnowledgePack,
} from "../knowledge-pack";
import {
  ensureGraphjinGuard as defaultEnsureGraphjinGuard,
  resolveBinaryOnPath as defaultResolveBinaryOnPath,
} from "./graphjin-guard";
import {
  formatWorkMemoryPromptContext as defaultFormatWorkMemoryPromptContext,
  effectiveMemoryLayer,
  rememberWorkMemory,
} from "./memory";
import {
  buildOperatorProfileSection,
  getOperatorProfile,
  getWorkRunActor,
} from "./personas";
import { buildWorkPrompt } from "./prompt";
import { compactIfNeeded, type ThreadCompaction } from "./compact-transcript";
import {
  finishWorkRun,
  getWorkThreadBundle,
  markWorkRunRunning,
  saveAssistantWorkMessage,
  setWorkRunValue,
  setWorkThreadBackendState,
} from "./store";
import type { PluginActionDescriptor } from "./tools";
import { createToolOutputRecorder } from "./tool-output/metrics";
import { runAgentBackend } from "./agent-core";
import {
  parseAppWorkContext,
  parseRecordWorkContext,
  type WorkDataSurface,
} from "./data-surface";
import {
  inProcessControlPlane,
  type AgentControlPlane,
  type PluginCatalog,
} from "./control-plane";
import {
  ensureWorkWorkspace as defaultEnsureWorkWorkspace,
  listInstalledSkills as defaultListInstalledSkills,
} from "./workspace";
import { observeSafely, type HarnessObserver } from "@neko/telemetry";

/**
 * Delivery channel for a run. "web" renders a2ui cards (the channel injects the
 * render capability); other channels answer in plain markdown and may inject
 * their own render tool later. See docs/PER_CHANNEL_RENDERING.md.
 */
export type RunChannel = "web" | "telegram" | "slack" | (string & {});

export type RunChatTurnOptions = {
  orgId: string;
  threadId: string;
  runId: string;
  message: string;
  /** Delivery channel; defaults to "web". Gates output rendering. */
  channel?: RunChannel;
  emit: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
  /**
   * Plugin action kinds to surface to the agent as MCP tools, one
   * per kind. The worker passes its plugin registry snapshot here;
   * tests pass an empty array to keep the agent's surface stable.
   * Mounted for Hermes through the sandbox MCP bridge.
   */
  pluginActions?: readonly PluginActionDescriptor[];
  /**
   * Control-plane impl for the DB-touching MCP tools. Default (undefined)
   * uses the in-process plane; the agent sandbox injects a broker client.
   */
  controlPlane?: AgentControlPlane;
  /** Metadata-only observation stream shared by production and eval runs. */
  observer?: HarnessObserver;
};

// Tests can substitute any of these without touching the call site. Production
// callers pass nothing and get the real implementations.
export type RunChatTurnDeps = {
  resolveAgentBackend: typeof defaultResolveAgentBackend;
  ensureWorkWorkspace: typeof defaultEnsureWorkWorkspace;
  resolveBinaryOnPath: typeof defaultResolveBinaryOnPath;
  ensureGraphjinGuard: typeof defaultEnsureGraphjinGuard;
  formatWorkMemoryPromptContext: typeof defaultFormatWorkMemoryPromptContext;
  prefetchKnowledgeForOrg: typeof defaultPrefetchKnowledgeForOrg;
  listInstalledSkills: typeof defaultListInstalledSkills;
  /**
   * Runs the agent loop. Production hosts inject the OpenShell sandbox
   * impl (agentRuntimeDepsFromEnv) — SEC9: the only runtime. The default
   * (runAgentBackend in-process) exists for tests, which exercise the
   * core without a sandbox. The DB-bound prologue/epilogue stay host-side.
   */
  runCore: typeof runAgentBackend;
};

export type RunChatTurnResult = {
  status: "completed" | "failed" | "cancelled";
  finalText: string;
  error?: string;
};

function backendLabel(id: string): string {
  void id;
  return "Hermes";
}

/**
 * Strip any unexecuted ACP/hermes tool-call left in display text — e.g.
 * `call:default_api:read_file{limit:100,path:analyze.py}`. A turn cut short
 * mid-step (step budget, loop) can leave one dangling in finalText; it must
 * never reach a user on any channel. Matches `call:<ns>:<tool>{…}` (closed or
 * truncated at end-of-text). Returns the remaining prose, trimmed.
 */
function stripDanglingToolCalls(text: string): string {
  return text
    .replace(/\bcall:[A-Za-z0-9_.:-]+\s*\{[^{}]*(?:\}|$)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectStrings(item, depth + 1),
    );
  }
  return [];
}

/**
 * OpenShell returns policy denials inside tool output JSON. Convert that
 * implementation detail into a channel-neutral event while the exact host is
 * still available. Exported for focused regression tests.
 */
export function extractNetworkPolicyDenial(
  event: AgentEvent,
): Extract<AgentEvent, { type: "capability_denied" }> | null {
  if (event.type !== "tool_end") return null;
  const text = [event.error ?? "", ...collectStrings(event.result)].join("\n");
  if (!/policy_denied|not permitted by policy/i.test(text)) return null;
  const match = text.match(
    /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+([a-z0-9.-]+)(?::(\d+))?(\/[^\s"'\\]*)?\s+not permitted by policy/i,
  );
  if (!match) return null;
  const port = match[3] ? Number(match[3]) : undefined;
  return {
    type: "capability_denied",
    capability: "network_egress",
    reason: "policy_denied",
    host: match[2].toLowerCase(),
    ...(Number.isFinite(port) ? { port } : {}),
    method: match[1].toUpperCase(),
    ...(match[4] ? { path: match[4] } : {}),
  };
}

export async function runChatTurn(
  opts: RunChatTurnOptions,
  deps: Partial<RunChatTurnDeps> = {},
): Promise<RunChatTurnResult> {
  const { orgId, threadId, runId, message, emit, signal } = opts;

  const resolveAgentBackend = deps.resolveAgentBackend ?? defaultResolveAgentBackend;
  const ensureWorkWorkspace = deps.ensureWorkWorkspace ?? defaultEnsureWorkWorkspace;
  const resolveBinaryOnPath = deps.resolveBinaryOnPath ?? defaultResolveBinaryOnPath;
  const ensureGraphjinGuard = deps.ensureGraphjinGuard ?? defaultEnsureGraphjinGuard;
  const formatWorkMemoryPromptContext =
    deps.formatWorkMemoryPromptContext ?? defaultFormatWorkMemoryPromptContext;
  const prefetchKnowledgeForOrg =
    deps.prefetchKnowledgeForOrg ?? defaultPrefetchKnowledgeForOrg;
  const listInstalledSkills =
    deps.listInstalledSkills ?? defaultListInstalledSkills;
  const runCore = deps.runCore ?? runAgentBackend;

  await markWorkRunRunning(runId);

  const bundle = await getWorkThreadBundle(orgId, threadId);
  if (!bundle) {
    const errMsg = "Thread deleted before run start.";
    await finishWorkRun(runId, "failed", errMsg);
    console.warn(
      `[work-run] thread ${threadId} not found for run ${runId}; marking failed and skipping`,
    );
    return { status: "failed", finalText: "", error: errMsg };
  }
  const appContext = parseAppWorkContext(
    bundle.thread.backendState.appContext,
  );
  const recordContext = parseRecordWorkContext(
    bundle.thread.backendState.recordContext,
  );
  const dataSurface: WorkDataSurface = appContext || recordContext
    ? "records"
    : "customer";

  const backend = await resolveAgentBackend(orgId);
  const workspace = await ensureWorkWorkspace(orgId, threadId, runId);

  // Knowledge layering: agentic deployments (auth_mode=jwt) get the slim
  // gj_catalog bootstrap; legacy ones keep the broad discovery dumps.
  if (dataSurface === "customer") {
    const refresh = await prefetchKnowledgeForOrg(orgId, workspace.knowledgeRoot);
    if (!refresh.ok) {
      console.warn(
        `[work-run] org=${orgId} knowledge refresh failed (${refresh.error}); proceeding with on-disk pack`,
      );
    }
  }
  const knowledge = dataSurface === "records"
    ? { mode: "legacy" as const, tables: "{}", namespaces: "{}", insights: "{}", syntax: "{}" }
    : await readKnowledgePack(knowledgePackPaths(workspace.knowledgeRoot));

  let assistantText = "";
  const operationId = `work:${runId}`;
  const stageOperationId = `${operationId}:agent`;
  const modelOperationId = `${operationId}:model:1`;
  let agentStartedAt = Date.now();
  const toolStarts = new Map<string, { name: string; startedAt: number }>();
  let firstOutputObserved = false;
  let stageOpen = false;
  let modelOpen = false;
  let outerUsage:
    | Extract<AgentEvent, { type: "usage" }>
    | undefined;
  const observe = async (
    input: Parameters<HarnessObserver["observe"]>[0],
  ): Promise<void> => observeSafely(opts.observer, input);
  // Token instrumentation: correlate each tool_end back to its tool_start name
  // and record output size. Flag-gated (OPENNEKO_TOOL_OUTPUT_METRICS) — see
  // work/tool-output/metrics.ts.
  const toolRecorder = createToolOutputRecorder();
  const emittedCapabilityDenials = new Set<string>();
  const wrappedEmit = async (event: AgentEvent): Promise<void> => {
    if (event.type === "message" && event.role === "assistant") {
      assistantText += event.content;
    }
    toolRecorder.observe(event);
    if (
      !firstOutputObserved &&
      ((event.type === "message" && event.role === "assistant") ||
        event.type === "surface")
    ) {
      firstOutputObserved = true;
      const firstOutputMs = Date.now() - agentStartedAt;
      await observe({
        kind: "model.first_chunk",
        operationId: modelOperationId,
        parentOperationId: stageOperationId,
        measurements: { firstOutputMs, coverage: "unavailable" },
      });
      await observe({
        kind: "run.first_output",
        operationId,
        measurements: { firstOutputMs, coverage: "unavailable" },
      });
    }
    if (event.type === "tool_start") {
      toolStarts.set(event.id, { name: event.name, startedAt: Date.now() });
      await observe({
        kind: "tool.start",
        operationId: `${operationId}:tool:${event.id}`,
        parentOperationId: modelOperationId,
        attributes: { "gen_ai.tool.name": event.name },
        measurements: {
          inputBytes: byteLength(event.input),
          coverage: "unavailable",
        },
      });
      if (isGraphjinAgentTool(event.name)) {
        await observe({
          kind: "delegation.start",
          operationId: `${operationId}:delegation:${event.id}`,
          parentOperationId: modelOperationId,
          attributes: { "openneko.delegation.target": "graphjin-agent" },
        });
        await observe({
          kind: "model.request",
          operationId: `${operationId}:inner-model:${event.id}`,
          parentOperationId: `${operationId}:delegation:${event.id}`,
          attributes: { "openneko.model.scope": "inner" },
        });
      }
    } else if (event.type === "tool_end") {
      const started = toolStarts.get(event.id);
      toolStarts.delete(event.id);
      await observe({
        kind: "tool.end",
        operationId: `${operationId}:tool:${event.id}`,
        parentOperationId: modelOperationId,
        status: event.error ? "error" : "ok",
        ...(event.error ? { errorType: "tool_error" } : {}),
        attributes: {
          "gen_ai.tool.name": started?.name ?? "unknown",
        },
        measurements: {
          ...(started ? { durationMs: Date.now() - started.startedAt } : {}),
          outputBytes: byteLength(event.result ?? event.error),
          coverage: "unavailable",
        },
      });
      if (started && isGraphjinAgentTool(started.name)) {
        const inner = normalizeGraphjinAgentUsage(event.result);
        await observe({
          kind: "model.response",
          operationId: `${operationId}:inner-model:${event.id}`,
          parentOperationId: `${operationId}:delegation:${event.id}`,
          status: event.error ? "error" : "ok",
          ...(event.error ? { errorType: "graphjin_agent_error" } : {}),
          attributes: {
            "openneko.model.scope": "inner",
            ...(inner?.provider
              ? { "gen_ai.provider.name": inner.provider }
              : {}),
            ...(inner?.model ? { "gen_ai.response.model": inner.model } : {}),
          },
          measurements: inner?.usage ?? {
            coverage: "unavailable",
            missingReasons: ["GraphJin agent response omitted normalized usage"],
          },
        });
        await observe({
          kind: "delegation.end",
          operationId: `${operationId}:delegation:${event.id}`,
          parentOperationId: modelOperationId,
          status: event.error ? "error" : "ok",
          ...(event.error ? { errorType: "graphjin_agent_error" } : {}),
          attributes: { "openneko.delegation.target": "graphjin-agent" },
        });
      }
    } else if (event.type === "usage" && event.source === "outer") {
      outerUsage = event;
    } else if (event.type === "action_request_emit") {
      await observe({
        kind: "policy.decision",
        operationId: `${operationId}:policy:${event.action_request_id}`,
        parentOperationId: operationId,
        status: "ok",
        attributes: {
          "openneko.policy.decision": event.decision,
          "openneko.action.kind": event.kind,
          "openneko.action.scope": event.scope,
        },
      });
    } else if (event.type === "action_request_result") {
      await observe({
        kind: "approval.decision",
        operationId: `${operationId}:action:${event.action_request_id}`,
        parentOperationId: operationId,
        status: event.status === "failed" ? "error" : "ok",
        attributes: {
          "openneko.action.kind": event.kind,
          "openneko.action.status": event.status,
        },
      });
    }
    await emit(event);
    const denial = extractNetworkPolicyDenial(event);
    if (denial) {
      const key = `${denial.host}:${denial.port ?? 443}`;
      if (!emittedCapabilityDenials.has(key)) {
        emittedCapabilityDenials.add(key);
        await emit(denial);
      }
    }
  };

  // Production resolves and guards GraphJin inside the OpenShell sandbox.
  // The host path is retained only for the in-process test harness.
  const graphjinBinary =
    runCore === runAgentBackend ? await resolveBinaryOnPath("graphjin") : null;
  if (runCore === runAgentBackend && !graphjinBinary && dataSurface === "customer") {
    const errMsg = "graphjin CLI is not installed on PATH.";
    await wrappedEmit({ type: "error", message: errMsg });
    await finishWorkRun(runId, "failed", errMsg);
    await wrappedEmit({ type: "done", result: { status: "failed" } });
    throw new Error(errMsg);
  }
  // K1 actor drives the guard (GJ4 token + GJ5 grants), the persona
  // (CV3) and the memory layer (CV2).
  const actor = await getWorkRunActor(runId);
  // GJ4: when the data source runs source mode (auth_mode='jwt'), the
  // run's CLI calls carry this run's actor token — a per-run client.json
  // the guard pins XDG_CONFIG_HOME at. Legacy mode is unchanged.
  let guardXdg: string | undefined;
  if (dataSurface === "customer") {
    const { data_source, db, desc, eq } = await import("@neko/db");
    const [src] = await db()
      .select({ authMode: data_source.auth_mode, mcpUrl: data_source.mcp_url })
      .from(data_source)
      .where(eq(data_source.org_id, orgId))
      .orderBy(desc(data_source.is_default), data_source.created_at)
      .limit(1);
    if (src?.authMode === "jwt" && src.mcpUrl) {
      const { provisionGraphjinClientAuth } = await import(
        "../graphjin/client-auth"
      );
      const auth = await provisionGraphjinClientAuth({
        runRoot: workspace.runRoot,
        serverUrl: src.mcpUrl,
        orgId,
        userId: actor.userId,
        role:
          actor.role === "admin" || actor.role === "member"
            ? actor.role
            : "service",
      });
      guardXdg = auth.xdgConfigHome;
    }
  }
  // GJ5: an org policy may grant an admin actor specific write
  // subcommands; everyone else keeps the read-only guard.
  const { resolveGraphjinWriteGrants } = await import("./graphjin-actor-guard");
  const writeGrants = dataSurface === "customer"
    ? await resolveGraphjinWriteGrants(orgId, actor)
    : [];
  if (graphjinBinary) {
    await ensureGraphjinGuard(workspace.binRoot, graphjinBinary, {
      ...(guardXdg ? { xdgConfigHome: guardXdg } : {}),
      ...(writeGrants.length > 0 ? { allowSubcommands: writeGrants } : {}),
      ...(dataSurface === "records" ? { denyAll: true } : {}),
    });
  }

  try {
    await wrappedEmit({
      type: "status",
      message: `Starting ${backendLabel(backend.id)}…`,
    });

    // Rendering is a per-channel capability: a channel that can render the
    // a2ui surface gets it (web as cards, telegram as HTML via its plugin
    // projection). Thin channels answer in plain markdown — no rendering
    // vocabulary in their prompt. See docs/PER_CHANNEL_RENDERING.md.
    const RENDERING_CHANNELS = new Set(["web", "telegram"]);
    const customerSurface = dataSurface === "customer";
    const wantsCards =
      customerSurface && RENDERING_CHANNELS.has(opts.channel ?? "web");
    const supportsCardTool = customerSurface && backend.capabilities.mcpTools;
    const supportsSkillTool = customerSurface && backend.capabilities.mcpTools;
    const supportsMemoryTool = customerSurface && backend.capabilities.mcpTools;
    const supportsWorkflowTool = customerSurface && backend.capabilities.mcpTools;
    const supportsPolicyTool = customerSurface && backend.capabilities.mcpTools;
    const supportsPluginManagerTool =
      customerSurface && backend.capabilities.mcpTools;
    const sourceConfigSettings = dataSurface === "customer"
      ? await getGraphjinConfigSettingsForOrg(orgId)
      : { sourceConfigEnabled: false };
    const supportsSourceConfigTool =
      backend.capabilities.mcpTools &&
      actor.role === "admin" &&
      (opts.channel ?? "web") === "web" &&
      sourceConfigSettings.sourceConfigEnabled;
    const inlineTranscript = !backend.capabilities.sessionResume;

    // Inline-transcript backends grow unbounded on long threads — fold older
    // turns into a rolling summary, keeping the recent tail verbatim.
    let priorSummary: string | undefined;
    let transcriptRows: typeof bundle.messages = bundle.messages;
    let newCompaction: ThreadCompaction | undefined;
    if (inlineTranscript) {
      const prior = (
        bundle.thread.backendState as { compaction?: ThreadCompaction }
      ).compaction;
      const compacted = await compactIfNeeded({
        messages: bundle.messages,
        prior,
        orgId,
        now: new Date().toISOString(),
      });
      priorSummary = compacted.summary;
      transcriptRows = compacted.kept;
      newCompaction = compacted.newCompaction;
    }

    const messages: AgentChatMessage[] = transcriptRows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      runId: row.runId,
      createdAt: row.createdAt,
    }));

    await wrappedEmit({
      type: "status",
      message: "Retrieving relevant context…",
    });

    const [memoryContext, installedSkills, profile] = await Promise.all([
      customerSurface
        ? formatWorkMemoryPromptContext(
            {
              orgId,
              threadId,
              runId,
              userId: effectiveMemoryLayer(orgId, actor),
            },
            // Use the latest user message as the retrieval query so we pull
            // memories semantically close to what the operator just asked.
            { contextQuery: message, contextLimit: 5 },
          )
        : Promise.resolve(""),
      listInstalledSkills(workspace.skillsRoot).then((skills) =>
        customerSurface
          ? skills
          : skills.filter((skill) => skill.name === "records"),
      ),
      getOperatorProfile(orgId, actor.userId),
    ]);
    const operatorProfile = buildOperatorProfileSection(profile);
    let pluginCatalog: PluginCatalog | undefined;
    const mayNeedCapabilityRecovery =
      /\b(integration|plugin|network|egress|live data|external api|weather)\b/i.test(
        message,
      );
    if (
      !supportsPluginManagerTool &&
      actor.role === "admin" &&
      mayNeedCapabilityRecovery
    ) {
      try {
        pluginCatalog = await (opts.controlPlane ?? inProcessControlPlane).listPlugins({
          orgId,
        });
      } catch (error) {
        console.warn(
          `[work-run] marketplace lookup failed: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    const prompt = buildWorkPrompt({
      backend: backend.id,
      workspace,
      knowledge,
      messages,
      currentUserMessage: message,
      priorSummary,
      memoryContext,
      operatorProfile,
      installedSkills,
      wantsCards,
      supportsCardTool,
      supportsSkillTool,
      supportsMemoryTool,
      supportsWorkflowTool,
      supportsPolicyTool,
      supportsSourceConfigTool,
      supportsPluginManagerTool,
      pluginCatalog,
      inlineTranscript,
      pluginActions: customerSurface ? (opts.pluginActions ?? []) : [],
      dataSurface,
      ...(appContext ? { appContext } : {}),
      ...(recordContext ? { recordContext } : {}),
    });

    agentStartedAt = Date.now();
    await observe({
      kind: "stage.start",
      operationId: stageOperationId,
      parentOperationId: operationId,
      attributes: { "openneko.stage": "agent" },
    });
    stageOpen = true;
    await observe({
      kind: "model.request",
      operationId: modelOperationId,
      parentOperationId: stageOperationId,
      attributes: {
        "openneko.model.scope": "outer",
        "openneko.backend": backend.id,
        ...(backend.model ? { "gen_ai.request.model": backend.model } : {}),
      },
    });
    modelOpen = true;
    const result = await runCore({
      backend,
      prompt,
      userMessage: message,
      orgId,
      threadId,
      runId,
      workspace,
      backendState: bundle.thread.backendState,
      pluginActions: customerSurface ? (opts.pluginActions ?? []) : [],
      sourceConfigEnabled: supportsSourceConfigTool,
      dataSurface,
      controlPlane: opts.controlPlane ?? inProcessControlPlane,
      wantsCards,
      emit: wrappedEmit,
      signal,
    });
    const agentStatus = result.status === "completed" ? "ok" : "error";
    await observe({
      kind: "model.response",
      operationId: modelOperationId,
      parentOperationId: stageOperationId,
      status: agentStatus,
      ...(result.error ? { errorType: "agent_backend_error" } : {}),
      attributes: {
        "openneko.model.scope": "outer",
        ...(outerUsage?.provider
          ? { "gen_ai.provider.name": outerUsage.provider }
          : {}),
        ...(outerUsage?.model
          ? { "gen_ai.response.model": outerUsage.model }
          : {}),
      },
      measurements: outerUsage?.usage ?? {
        coverage: "unavailable",
        missingReasons: ["backend emitted no normalized usage"],
      },
    });
    modelOpen = false;
    await observe({
      kind: "stage.end",
      operationId: stageOperationId,
      parentOperationId: operationId,
      status: agentStatus,
      attributes: { "openneko.stage": "agent" },
      measurements: {
        durationMs: Date.now() - agentStartedAt,
        coverage: "unavailable",
      },
    });
    stageOpen = false;

    const backendStateChanged =
      result.backendState && result.backendState !== bundle.thread.backendState;
    if (backendStateChanged || newCompaction) {
      const base = (
        backendStateChanged ? result.backendState : bundle.thread.backendState
      ) as Record<string, unknown>;
      const protectedBase = {
        ...base,
        ...(appContext ? { appContext } : {}),
        ...(recordContext ? { recordContext } : {}),
      };
      await setWorkThreadBackendState(
        threadId,
        newCompaction
          ? { ...protectedBase, compaction: newCompaction }
          : protectedBase,
      );
    }

    await finishWorkRun(runId, result.status, result.error ?? null);

    // Hermes /work emits plugin action calls as `neko_action_request`
    // fences (no MCP tool registry to use). Parse them out and route
    // each through the same policy + DB + emit path the MCP tools
    // use, so the agent's tool surface is identical across backends
    // from the user's perspective.
    // Side-effect fences are parsed from the RAW agent output, not finalText:
    // Hermes hides builder fences from finalText (it collapses to the a2ui
    // markdown) and from the message stream, so only rawText still carries
    // them. This falls back to finalText when rawText is absent. Each fence type is parsed independently
    // off the same source — they're distinct delimited blocks.
    const fenceSource =
      (result.rawText ?? result.finalText).trim() || assistantText.trim();
    const actionFences = extractActionRequestFences(fenceSource);
    for (const payload of actionFences.payloads) {
      try {
        await handleWorkActionRequest(
          {
            orgId,
            workRunId: runId,
            threadId,
            emit: wrappedEmit,
          },
          payload,
          payload.summary,
        );
      } catch (err) {
        console.warn(
          `[work-run] handleWorkActionRequest failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Workflow / policy save fences are a compatibility fallback. Same chain
    // pattern as action fences above: persist, emit a confirmation
    // surface, strip the fence body from the displayed text.
    const workflowFence = extractWorkflowSaveFence(fenceSource);
    if (workflowFence.payload) {
      try {
        const saved = await saveWorkflowWithTrigger({
          orgId,
          name: workflowFence.payload.name,
          description: workflowFence.payload.description,
          goal: workflowFence.payload.goal,
          systemPromptOverlay: workflowFence.payload.systemPromptOverlay,
          steps: workflowFence.payload.steps,
          triggers: workflowFence.payload.triggers,
          createdByThreadId: threadId,
          createdByRunId: runId,
        });
        await wrappedEmit({
          type: "surface",
          messages: workflowSavedCard({
            workflow: saved.workflow,
            action: saved.action,
          }),
        });
        if (saved.subscription) {
          await wrappedEmit({
            type: "surface",
            messages: subscriptionSavedCard({
              subscription: saved.subscription,
              workflowName: saved.workflow.name,
            }),
          });
        } else if (saved.triggerError) {
          await wrappedEmit({
            type: "error",
            message: `workflow saved, but its data trigger was not wired (${saved.triggerError.code}): ${saved.triggerError.message}`,
          });
        }
      } catch (err) {
        await wrappedEmit({
          type: "error",
          message: `workflow save failed: ${err instanceof Error ? err.message : err}`,
        });
      }
    } else if (workflowFence.errors.length > 0) {
      const reasons = workflowFence.errors.map((e) => e.reason).join("; ");
      await wrappedEmit({
        type: "error",
        message: `workflow save fence invalid: ${reasons}`,
      });
    }

    const policyFence = extractRuleSaveFence(fenceSource);
    if (policyFence.payload) {
      try {
        const saved = await upsertActionPolicyByName({
          orgId,
          name: policyFence.payload.name,
          description: policyFence.payload.description ?? "",
          appliesToKinds: policyFence.payload.applies_to_kinds,
          appliesToScopes: policyFence.payload.applies_to_scopes as ActionScope[],
          mode: policyFence.payload.mode as ActionPolicyMode,
          riskThresholdAutoApprove:
            (policyFence.payload.risk_threshold_auto_approve as
              | RiskLevel
              | undefined) ?? null,
          allowedTargets: policyFence.payload.allowed_targets ?? null,
          deniedTargets: policyFence.payload.denied_targets ?? null,
          limits: policyFence.payload.limits,
          approverRole: policyFence.payload.approver_role ?? null,
          priority: policyFence.payload.priority,
          enabled: policyFence.payload.enabled,
          createdByThreadId: threadId,
          createdByRunId: runId,
        });
        await wrappedEmit({
          type: "surface",
          messages: policySavedCard({
            policy: saved.policy,
            action: saved.action,
          }),
        });
      } catch (err) {
        await wrappedEmit({
          type: "error",
          message: `policy save failed: ${err instanceof Error ? err.message : err}`,
        });
      }
    } else if (policyFence.errors.length > 0) {
      const reasons = policyFence.errors.map((e) => e.reason).join("; ");
      await wrappedEmit({
        type: "error",
        message: `policy save fence invalid: ${reasons}`,
      });
    }

    // Per-run analysis value estimate (the human time the answer saved,
    // excluding any actions which carry their own estimate). Parsed from the
    // same raw source, server-clamped, persisted, and echoed in `done` so the
    // UI can show it live. Best-effort: a missing/invalid fence leaves it null.
    const valueFence = extractValueFence(fenceSource);
    const analysisMinutes = clampAnalysisMinutes(valueFence.payload?.minutes_saved);
    if (valueFence.payload) {
      try {
        await setWorkRunValue(runId, {
          minutes: analysisMinutes,
          basis: valueFence.payload.basis ?? null,
        });
      } catch (err) {
        console.warn(
          `[work-run] setWorkRunValue failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // Suggested follow-up questions — channel-agnostic content, emitted as an
    // event any channel (Ask rail, Telegram, …) can surface as "ask next".
    const followups = extractFollowupsFence(fenceSource);
    if (followups.payload) {
      await wrappedEmit({
        type: "followups",
        items: followups.payload.followups,
      });
    }

    // The answer's headline numbers — channel-agnostic content, emitted as an
    // event each channel renders in the answer that produced them.
    const vitals = extractVitalsFence(fenceSource);
    if (vitals.payload) {
      await wrappedEmit({
        type: "vitals",
        items: vitals.payload.vitals,
      });
    }

    // Pull any neko_memory fences out of the raw agent response and persist
    // them. This is harmless when Hermes used the MCP save tool.
    const { ops: memoryOps } = extractMemoryFences(fenceSource);
    for (const op of memoryOps) {
      try {
        await rememberWorkMemory({
          orgId,
          threadId,
          runId,
          text: op.text,
          kind: "business_rule",
          scope: op.scope ?? "global",
          pinned: op.pinned ?? true,
        });
      } catch (err) {
        console.error(
          "[work-memory] fence-driven save failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // The persisted assistant message is the cleaned DISPLAY text (finalText),
    // with any fence bodies that leaked into it stripped — never the raw
    // source, which still holds the a2ui block + builder fences. The a2ui card
    // and builder confirmation cards were already emitted as surfaces.
    let persistedText = extractActionRequestFences(result.finalText.trim()).text;
    persistedText = extractWorkflowSaveFence(persistedText).text;
    persistedText = extractRuleSaveFence(persistedText).text;
    persistedText = extractValueFence(persistedText).text;
    persistedText = extractFollowupsFence(persistedText).text;
    persistedText = extractVitalsFence(persistedText).text;
    persistedText = extractMemoryFences(persistedText).text;
    // A turn cut short mid-step (budget/loop) can end with an unexecuted
    // tool-call like `call:default_api:read_file{…}` left in the text. Never
    // surface that — strip it so a broken turn degrades to its prose (or empty,
    // which delivery + persistence then skip) instead of leaking a raw call.
    persistedText = stripDanglingToolCalls(persistedText);
    if (persistedText) {
      await saveAssistantWorkMessage({
        orgId,
        threadId,
        runId,
        content: persistedText,
      });
    }

    await wrappedEmit({
      type: "done",
      result: { status: result.status, minutesSaved: analysisMinutes ?? 0 },
    });

    return {
      status: result.status,
      // The cleaned display text (machine fences — neko_value/neko_vitals,
      // action/workflow/rule/followups/memory — stripped), never the raw source.
      // Channels deliver this as the converse body; leaking fences render as raw
      // JSON (and break Telegram's HTML parser) on a channel that shows the text.
      finalText: persistedText,
      error: result.error,
    };
  } catch (error) {
    const aborted =
      signal?.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.message.includes("aborted")));
    const status: "failed" | "cancelled" = aborted ? "cancelled" : "failed";
    const errMsg = aborted
      ? "Cancelled by user."
      : error instanceof Error
        ? error.message
        : "Work run failed unexpectedly.";
    for (const [toolId, tool] of toolStarts) {
      if (isGraphjinAgentTool(tool.name)) {
        await observe({
          kind: "model.response",
          operationId: `${operationId}:inner-model:${toolId}`,
          parentOperationId: `${operationId}:delegation:${toolId}`,
          status: "error",
          errorType: aborted ? "cancelled" : "graphjin_agent_error",
          measurements: {
            coverage: "unavailable",
            missingReasons: ["GraphJin agent call did not complete"],
          },
        });
        await observe({
          kind: "delegation.end",
          operationId: `${operationId}:delegation:${toolId}`,
          parentOperationId: modelOperationId,
          status: "error",
          errorType: aborted ? "cancelled" : "graphjin_agent_error",
          attributes: { "openneko.delegation.target": "graphjin-agent" },
        });
      }
      await observe({
        kind: "tool.end",
        operationId: `${operationId}:tool:${toolId}`,
        parentOperationId: modelOperationId,
        status: "error",
        errorType: aborted ? "cancelled" : "agent_backend_error",
        attributes: { "gen_ai.tool.name": tool.name },
        measurements: {
          durationMs: Date.now() - tool.startedAt,
          coverage: "unavailable",
        },
      });
    }
    toolStarts.clear();
    if (modelOpen) {
      await observe({
        kind: "model.response",
        operationId: modelOperationId,
        parentOperationId: stageOperationId,
        status: "error",
        errorType: aborted ? "cancelled" : "agent_backend_error",
        measurements: outerUsage?.usage ?? {
          coverage: "unavailable",
          missingReasons: ["model call did not complete with normalized usage"],
        },
      });
      modelOpen = false;
    }
    if (stageOpen) {
      await observe({
        kind: "stage.end",
        operationId: stageOperationId,
        parentOperationId: operationId,
        status: "error",
        errorType: aborted ? "cancelled" : "agent_backend_error",
        attributes: { "openneko.stage": "agent" },
        measurements: {
          durationMs: Date.now() - agentStartedAt,
          coverage: "unavailable",
        },
      });
      stageOpen = false;
    }
    await wrappedEmit({ type: "error", message: errMsg });
    await finishWorkRun(runId, status, aborted ? null : errMsg);
    await wrappedEmit({ type: "done", result: { status } });
    if (!aborted) throw error;
    return { status, finalText: assistantText };
  }
}

function byteLength(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return Buffer.byteLength(
      typeof value === "string" ? value : JSON.stringify(value),
      "utf8",
    );
  } catch {
    return 0;
  }
}

function isGraphjinAgentTool(name: string): boolean {
  return name.toLocaleLowerCase().includes("neko_graphjin_agent");
}
