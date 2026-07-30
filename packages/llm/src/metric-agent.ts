import { data_source, db, desc, eq } from "@neko/db";
import {
  shellToolName,
  type AgentBackend,
  type AgentEvent,
  type AgentTokenUsage,
} from "./agent-backend";
import { resolveAgentBackend } from "./agent-backend-resolver";
import { parseJsonFromOutput } from "./agent-backends/hermes";
import { runValidatedAgentTurn } from "./agent-validate-loop";
import {
  buildDiscoveryPathwaysSection,
  getDiscoveryPathways,
} from "./discovery-pathways";
import {
  knowledgePackPaths,
  prefetchKnowledgeForOrg,
  readKnowledgePack,
} from "./knowledge-pack";
import { buildMetricPrompt } from "./metric-prompt";
import {
  formatGlobalMemoryPromptContext,
} from "./work/memory";
import { sandboxAgentBackendForJob } from "./work/sandbox-launcher";
import {
  ensureIsolatedJobWorkspace,
  ensureWorkWorkspace,
} from "./work/workspace";

// Keep in sync with ROLE_FOCUS (bootstrap-metrics-writer.ts) and the
// onboarding ALL_SEATS list — every seat the product offers must be here.
export const EXEC_ROLES = [
  "CEO",
  "CFO",
  "COO",
  "CRO",
  "CMO",
  "CIO",
  "CPO",
] as const;
export type ExecRole = (typeof EXEC_ROLES)[number];

export type MetricAgentInput = {
  orgId: string;
  role: ExecRole;
  slug: string;
  title: string;
  why: string;
  chartHint: "kpi" | "line" | "bar" | "donut" | "area";
  jobId?: string;
  debug?: boolean;
  /**
   * Explicit experiment arm. Production remains "direct": the outer agent
   * writes GraphQL and calls OpenNeko's read broker. "agent" delegates
   * discovery + execution to GraphJin's built-in read-only server agent.
   */
  graphjinPath?: GraphjinDataPath;
  /** Host-only experiment telemetry hook; never serialized into the sandbox. */
  onDiagnostics?: (diagnostics: MetricAgentDiagnostics) => void;
};

export type GraphjinDataPath = "direct" | "agent";

export type MetricAgentDiagnostics = {
  graphjinPath: GraphjinDataPath;
  promptChars: number;
  durationMs: number;
  attempts: number;
  toolCalls: Record<string, number>;
  toolOutputChars: number;
  outerTokens?: AgentTokenUsage;
  innerTokens?: AgentTokenUsage;
  totalTokens?: number;
};

export const TIME_WINDOW_GRAINS = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
  "all_time",
  "snapshot",
] as const;

export type TimeWindowGrain = (typeof TIME_WINDOW_GRAINS)[number];

export type TimeWindow = {
  grain: TimeWindowGrain;
  start: string | null;
  end: string | null;
  label: string;
};

export type MetricAgentResult = {
  reasoning: string;
  headlineMetric: string;
  headlineLabel: string;
  insightText: string;
  detailText: string;
  mood: "good" | "watch" | "bad";
  chartType: "kpi" | "line" | "bar" | "donut" | "area";
  chartData: Array<{ d: string; v: number; t?: number }>;
  timeWindow: TimeWindow;
};


export async function runMetricAgent(
  input: MetricAgentInput,
): Promise<MetricAgentResult> {
  const sources = await db()
    .select({ mcp_url: data_source.mcp_url })
    .from(data_source)
    .where(eq(data_source.org_id, input.orgId))
    .orderBy(desc(data_source.is_default), data_source.created_at)
    .limit(1);
  const mcpUrl = sources[0]?.mcp_url;
  if (!mcpUrl) {
    throw new Error(
      `no mcp_url for org ${input.orgId} — set data_source.mcp_url`,
    );
  }

  console.log(
    `[metric-agent] org=${input.orgId} role=${input.role} slug=${input.slug} mcp=${mcpUrl}`,
  );

  const knowledgeWorkspace = await ensureWorkWorkspace(
    input.orgId,
    "metric-agent",
    input.jobId ?? input.slug,
  );
  const refreshResult = await prefetchKnowledgeForOrg(
    input.orgId,
    knowledgeWorkspace.knowledgeRoot,
  );
  if (refreshResult.ok) {
    const totalBytes = refreshResult.files.reduce((n, f) => n + f.bytes, 0);
    console.log(
      `[metric-agent] org=${input.orgId} slug=${input.slug} knowledge refreshed (${refreshResult.files.length} files, ${totalBytes}B)`,
    );
  } else {
    console.warn(
      `[metric-agent] org=${input.orgId} slug=${input.slug} knowledge refresh failed (${refreshResult.error}); proceeding with on-disk pack`,
    );
  }
  const knowledge = await readKnowledgePack(
    knowledgePackPaths(knowledgeWorkspace.knowledgeRoot),
  );

  const backend = await resolveAgentBackend(input.orgId);
  const debug = input.debug === true;
  const graphjinPath = input.graphjinPath ?? "direct";
  const isolated = await ensureIsolatedJobWorkspace(
    `metric-${input.jobId ?? input.slug}`,
  );
  try {
    // Preload the top-5 global memories so pinned operator rules show up
    // verbatim. Anything narrower (per-card semantic match) is reachable
    // through the sandbox's search-only memory broker capability.
    const memoryContext = await formatGlobalMemoryPromptContext(input.orgId);
    const supportsMemorySearch = backend.capabilities.mcpTools;
    const sandboxedBackend = await sandboxAgentBackendForJob({
      backend,
      orgId: input.orgId,
      runId: input.jobId ?? input.slug,
      workspace: isolated.workspace,
      access: {
        graphjinRead: graphjinPath === "direct",
        graphjinAgent: graphjinPath === "agent",
        memorySearch: supportsMemorySearch,
      },
    });

    const basePrompt = buildMetricPrompt({
      input,
      knowledge,
      workspace: isolated.workspace,
      shellTool: shellToolName(backend.id),
      queryTool:
        graphjinPath === "direct"
          ? "mcp__neko_graphjin__execute_graphql"
          : undefined,
      dataAgentTool:
        graphjinPath === "agent"
          ? "mcp__neko_graphjin_agent__ask"
          : undefined,
      memoryContext,
      supportsMemorySearch,
    });
    // GJ3: role-shaped warm-start for discovery (cached per org/role/intent).
    const pathwaysSection = buildDiscoveryPathwaysSection(
      getDiscoveryPathways({
        orgId: input.orgId,
        role: input.role,
        intent: input.title,
        insightsJson: knowledge.insights,
      }),
    );
    const prompt = pathwaysSection
      ? `${basePrompt}\n\n${pathwaysSection}`
      : basePrompt;

    console.log(
      `[metric-agent] org=${input.orgId} slug=${input.slug} backend=${backend.id} graphjinPath=${graphjinPath} runtime=openshell`,
    );

    const startedAt = Date.now();
    const toolNames = new Map<string, string>();
    const toolCalls: Record<string, number> = {};
    let toolOutputChars = 0;
    let attempts = 0;
    let outerTokens: AgentTokenUsage | undefined;
    let innerTokens: AgentTokenUsage | undefined;
    const observeEvent = (event: AgentEvent): void => {
      if (event.type === "tool_start") {
        toolNames.set(event.id, event.name);
        toolCalls[event.name] = (toolCalls[event.name] ?? 0) + 1;
      } else if (event.type === "tool_end") {
        const name = toolNames.get(event.id);
        if (name && !(name in toolCalls)) toolCalls[name] = 1;
        try {
          toolOutputChars += JSON.stringify(event.result ?? event.error ?? "").length;
        } catch {
          // Diagnostics must never fail the metric run.
        }
        const graphjinUsage = findGraphjinTokenUsage(event.result);
        if (graphjinUsage) {
          innerTokens = addTokenUsage(innerTokens, graphjinUsage);
        }
      } else if (event.type === "usage") {
        outerTokens = addTokenUsage(outerTokens, event.usage);
      }
    };
    const observedBackend: AgentBackend = {
      id: sandboxedBackend.id,
      capabilities: sandboxedBackend.capabilities,
      run: async (options) => {
        attempts += 1;
        return sandboxedBackend.run(options);
      },
    };

    try {
      // GJ2: iterative validation loop — a malformed reply is fed back to the
      // agent for a corrective turn instead of failing the whole job. The
      // delegated path gets one outer attempt because GraphJin already owns a
      // bounded multi-step loop; repeating the full delegation compounds
      // latency and spend without adding new evidence.
      const { value: parsed } = await runValidatedAgentTurn<
        Partial<MetricAgentResult>
      >({
        backend: observedBackend,
        run: {
          prompt,
          orgId: input.orgId,
          tag: input.jobId,
          workspace: isolated.workspace,
          debug,
          onEvent: observeEvent,
        },
        maxAttempts: graphjinPath === "agent" ? 1 : undefined,
        label: `metric-agent org=${input.orgId} slug=${input.slug}`,
        validate: (finalText) => {
          const out = parseJsonFromOutput(
            finalText,
          ) as Partial<MetricAgentResult>;
          if (!out.headlineMetric && !out.insightText) {
            throw new Error(
              "JSON parsed but headlineMetric and insightText are both empty",
            );
          }
          return out;
        },
      });
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);

      const tw = (parsed.timeWindow ?? {}) as Partial<TimeWindow>;
      const result: MetricAgentResult = {
        reasoning: String(parsed.reasoning ?? ""),
        headlineMetric: String(parsed.headlineMetric ?? ""),
        headlineLabel: String(parsed.headlineLabel ?? ""),
        insightText: String(parsed.insightText ?? ""),
        detailText: String(parsed.detailText ?? ""),
        mood: parsed.mood as MetricAgentResult["mood"],
        chartType: parsed.chartType as MetricAgentResult["chartType"],
        chartData: Array.isArray(parsed.chartData)
          ? (parsed.chartData as MetricAgentResult["chartData"])
          : [],
        timeWindow: {
          grain: tw.grain as TimeWindowGrain,
          start: tw.start === null ? null : tw.start ? String(tw.start) : null,
          end: tw.end === null ? null : tw.end ? String(tw.end) : null,
          label: String(tw.label ?? ""),
        },
      };

      console.log(
        `[metric-agent] org=${input.orgId} slug=${input.slug} done in ${elapsedSec}s`,
      );

      return result;
    } finally {
      try {
        input.onDiagnostics?.({
          graphjinPath,
          promptChars: prompt.length,
          durationMs: Date.now() - startedAt,
          attempts,
          toolCalls,
          toolOutputChars,
          ...(outerTokens ? { outerTokens } : {}),
          ...(innerTokens ? { innerTokens } : {}),
          ...(outerTokens || innerTokens
            ? {
                totalTokens:
                  (outerTokens?.totalTokens ?? 0) +
                  (innerTokens?.totalTokens ?? 0),
              }
            : {}),
        });
      } catch {
        // Experiment telemetry must never change the metric run outcome.
      }
    }
  } finally {
    await isolated.cleanup();
  }
}

function addTokenUsage(
  current: AgentTokenUsage | undefined,
  next: AgentTokenUsage,
): AgentTokenUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    cacheReadTokens:
      (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens:
      (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    thoughtTokens:
      (current?.thoughtTokens ?? 0) + (next.thoughtTokens ?? 0),
    costUsd: (current?.costUsd ?? 0) + (next.costUsd ?? 0),
  };
}

function findGraphjinTokenUsage(value: unknown): AgentTokenUsage | undefined {
  const queue: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 6 || current.value == null) continue;
    if (typeof current.value === "string") {
      const trimmed = current.value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          queue.push({
            value: JSON.parse(trimmed),
            depth: current.depth + 1,
          });
        } catch {
          // Tool renderings can contain non-JSON prose; ignore those.
        }
      }
      continue;
    }
    if (typeof current.value !== "object") continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    const record = current.value as Record<string, unknown>;
    const promptTokens = nonNegativeNumber(record.prompt_tokens);
    const completionTokens = nonNegativeNumber(record.completion_tokens);
    const reportedTotal = nonNegativeNumber(record.total_tokens);
    if (
      promptTokens != null ||
      completionTokens != null ||
      reportedTotal != null
    ) {
      const inputTokens = promptTokens ?? 0;
      const outputTokens = completionTokens ?? 0;
      return {
        inputTokens,
        outputTokens,
        totalTokens: reportedTotal ?? inputTokens + outputTokens,
      };
    }
    for (const nested of Object.values(record)) {
      queue.push({ value: nested, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}
