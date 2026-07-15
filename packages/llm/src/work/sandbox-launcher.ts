import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  agentTurnTimeoutMs,
  type AgentBackend,
  type AgentEvent,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentWorkspace,
} from "../agent-backend";
import type { RunWorkflowAgentBackendInput } from "../workflows/agent-core";
import type { RunWorkflowTurnDeps } from "../workflows/run-workflow-turn";
import type { RunAgentBackendInput } from "./agent-core";
import type { RunChatTurnDeps } from "./run-chat-turn";
import { isHostLocalName, SANDBOX_HOST_ALIAS } from "./sandbox-net";
import { copySkillOverrides } from "./workspace";

// Wire protocol shared with the in-image entrypoint. The agent runs in a
// separate container, so these can't share a module at runtime — they MUST
// stay identical to apps/worker/src/agent-sandbox/protocol.ts (a unit test
// asserts that). The launcher greps the exec's stdout for these markers.
const EVENT_MARKER = "__openneko_event__";
const RESULT_MARKER = "__openneko_agent_result__";

/**
 * Path of the agent entrypoint inside the agent image (the `agent` Docker
 * stage). The agent image is a `pnpm deploy` of @neko/worker, so the worker
 * package is rooted at /app (not /app/apps/worker) — entry.ts lives at
 * /app/src/agent-sandbox/entry.ts and @neko/llm is bundled at /app/node_modules.
 */
const AGENT_ENTRY = "/app/src/agent-sandbox/entry.ts";
const SANDBOX_RUNTIME_DIR = ".openneko";

export interface SandboxLauncherOptions {
  /** `openshell` binary; default resolves from PATH. */
  cli?: string;
  /** Registered gateway name (mTLS) — preferred; else gatewayEndpoint; else CLI default. */
  gatewayName?: string;
  gatewayEndpoint?: string;
  /** Agent image (the Dockerfile `agent` stage), e.g. ghcr.io/open-neko/agent:<ver>. */
  agentImage: string;
  /** OpenShell provider holding the model key — the proxy injects it; never in the box. */
  modelProvider?: string;
  /** Model endpoint egress, per (host, binary) — scoped to the backend's connecting binary. */
  modelEgress?: ReadonlyArray<{ host: string; binary: string }>;
  /** Extra env exported into the exec sh-wrapper (e.g. HERMES_HOME). Values must be safe. */
  env?: Record<string, string>;
  /**
   * Alias the OpenShell-injected credential env var (holds the
   * `openshell:resolve:env:…` placeholder) to the env var the backend reads —
   * e.g. {from:"api_key", to:"GEMINI_API_KEY"} for hermes-gemini. The proxy
   * still substitutes the real key on egress, so the box only sees the
   * placeholder. `to` comes from the hermes provider→key map (mapHermesProvider).
   */
  keyAliases?: ReadonlyArray<{ from: string; to: string }>;
  /**
   * Host HERMES_HOME (hermesHomeForOrg) to mirror into the box KEYLESS — only
   * config.yaml travels; the `.env` is emptied so the proxy-injected key (via
   * keyAliases, process env) is what hermes uses. Set for the hermes backend.
   */
  hermesHomeHostPath?: string;
  /**
   * GJ6: path of the graphjin binary inside the agent image — the org's
   * data-source host is allowed for this binary so `graphjin cli` can
   * reach the GraphJin server from the box.
   */
  graphjinBinaryInBox?: string;
  /** Broker coords for the claude MCP-tool path (omitted for hermes). */
  brokerUrl?: string;
  /** Mint a per-run bearer token bound to {runId, orgId} (the broker forces
   *  org/run from the binding, never the request body). */
  brokerTokenFor?: (binding: { runId: string; orgId: string }) => string;
  /** Release the run's token after it finishes (called in the run's finally). */
  brokerRelease?: (runId: string) => void;
  execTimeoutMs?: number;
  onLog?: (line: string) => void;
}

type RunCore = (input: RunAgentBackendInput) => Promise<AgentRunResult>;
type RunWorkflowCore = (input: RunWorkflowAgentBackendInput) => Promise<AgentRunResult>;
export type AgentJobAccess = {
  /** Permit query-only GraphJin reads through the trusted host broker. */
  graphjinRead?: boolean;
  /** Permit search-only access to the org's team memory layer via the broker. */
  memorySearch?: boolean;
};

export type RunJobAgentBackendInput = {
  backend: AgentBackend;
  orgId: string;
  runId: string;
  workspace: AgentWorkspace;
  run: AgentRunOptions;
  access: AgentJobAccess;
  emit: (event: AgentEvent) => Promise<void>;
};

type RunJobCore = (input: RunJobAgentBackendInput) => Promise<AgentRunResult>;
type SandboxRunKind = "work" | "workflow" | "agent-job";
type SandboxRunInput =
  | RunAgentBackendInput
  | RunWorkflowAgentBackendInput
  | RunJobAgentBackendInput;

const SHELL_KEY_RX = /^[A-Z_][A-Z0-9_]*$/;
// Shell var names allow lowercase — the OpenShell credential is injected as `api_key`.
const SHELL_VARNAME_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type SerializableAgentRunOptions = Pick<
  AgentRunOptions,
  | "userMessage"
  | "timeoutMs"
  | "retries"
  | "debug"
  | "tag"
  | "skills"
  | "backendState"
  | "wantsCards"
  | "outputSchema"
  | "forkSession"
>;

function serializableAgentRunOptions(
  run: AgentRunOptions,
): SerializableAgentRunOptions {
  return {
    ...(run.userMessage !== undefined ? { userMessage: run.userMessage } : {}),
    ...(run.timeoutMs !== undefined ? { timeoutMs: run.timeoutMs } : {}),
    ...(run.retries !== undefined ? { retries: run.retries } : {}),
    ...(run.debug !== undefined ? { debug: run.debug } : {}),
    ...(run.tag !== undefined ? { tag: run.tag } : {}),
    ...(run.skills !== undefined ? { skills: run.skills } : {}),
    ...(run.backendState !== undefined ? { backendState: run.backendState } : {}),
    ...(run.wantsCards !== undefined ? { wantsCards: run.wantsCards } : {}),
    ...(run.outputSchema !== undefined ? { outputSchema: run.outputSchema } : {}),
    ...(run.forkSession !== undefined ? { forkSession: run.forkSession } : {}),
  };
}

type SandboxEgressRule = { host: string; binary: string; port?: number };

export type OpenShellSandboxPolicy = {
  version: 1;
  filesystem_policy: {
    include_workdir: true;
    read_only: string[];
    read_write: string[];
  };
  landlock: { compatibility: "best_effort" };
  process: { run_as_user: "sandbox"; run_as_group: "sandbox" };
  network_policies: Record<
    string,
    {
      name: string;
      binaries: Array<{ path: string }>;
      endpoints: Array<{
        host: string;
        port: number;
        protocol: "rest";
        enforcement: "enforce";
        rules: Array<{ allow: { method: "*"; path: "/**" } }>;
      }>;
    }
  >;
};

/**
 * Build the complete policy before sandbox creation. Grouping is by binary,
 * so model, broker, and GraphJin endpoints never gain one another's executable
 * allowlist through an endpoint/binary cross-product.
 */
export function buildSandboxPolicy(
  egress: ReadonlyArray<SandboxEgressRule>,
): OpenShellSandboxPolicy {
  const byBinary = new Map<
    string,
    Map<string, { host: string; port: number }>
  >();
  for (const rule of egress) {
    const port = rule.port ?? 443;
    const endpoints = byBinary.get(rule.binary) ?? new Map();
    endpoints.set(`${rule.host}\0${port}`, { host: rule.host, port });
    byBinary.set(rule.binary, endpoints);
  }

  const networkPolicies: OpenShellSandboxPolicy["network_policies"] = {};
  let index = 0;
  for (const [binary, endpoints] of [...byBinary.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const label =
      path.posix.basename(binary).replace(/[^a-zA-Z0-9_]/g, "_") ||
      "binary";
    const name = `allow_${label}_${index++}`;
    networkPolicies[name] = {
      name,
      binaries: [{ path: binary }],
      endpoints: [...endpoints.values()]
        .sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port)
        .map(({ host, port }) => ({
          host,
          port,
          protocol: "rest",
          enforcement: "enforce",
          rules: [{ allow: { method: "*", path: "/**" } }],
        })),
    };
  }

  return {
    version: 1,
    filesystem_policy: {
      include_workdir: true,
      read_only: [
        "/usr",
        "/lib",
        "/proc",
        "/dev/urandom",
        "/app",
        "/etc",
        "/var/log",
      ],
      read_write: ["/sandbox", "/tmp", "/dev/null"],
    },
    landlock: { compatibility: "best_effort" },
    process: { run_as_user: "sandbox", run_as_group: "sandbox" },
    network_policies: networkPolicies,
  };
}

export type StagedSandboxWorkspace = {
  orgRoot: string;
  workspace: AgentWorkspace;
  skillOverrides: string[];
};

function workspacePathInStage(
  workspace: AgentWorkspace,
  stageOrgRoot: string,
  source: string,
): string {
  const relative = path.relative(workspace.orgRoot, source);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return path.join(stageOrgRoot, relative);
  }
  throw new Error(`agent workspace path escapes org root: ${source}`);
}

async function copyDirectoryIfPresent(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Stage the least-privilege filesystem for one run. Durable memory is already
 * retrieved into the prompt; unrelated threads, prior runs, and unchanged
 * image-baked skills do not cross the sandbox boundary.
 */
export async function stageSandboxWorkspace(
  workspace: AgentWorkspace,
  stageDir: string,
): Promise<StagedSandboxWorkspace> {
  const stageOrgRoot = path.join(
    stageDir,
    "workspace",
    path.basename(workspace.orgRoot),
  );
  const stagedWorkspace = Object.fromEntries(
    Object.entries(workspace).map(([key, value]) => [
      key,
      workspacePathInStage(workspace, stageOrgRoot, value),
    ]),
  ) as AgentWorkspace;

  await mkdir(stageOrgRoot, { recursive: true });
  await Promise.all([
    copyDirectoryIfPresent(
      workspace.knowledgeRoot,
      stagedWorkspace.knowledgeRoot,
    ),
    copyDirectoryIfPresent(
      workspace.threadUploadsRoot,
      stagedWorkspace.threadUploadsRoot,
    ),
    copyDirectoryIfPresent(workspace.runRoot, stagedWorkspace.runRoot),
  ]);

  // Preserve the expected workspace shape even when a selected source is
  // empty, while deliberately leaving memory and sibling upload/run roots out.
  await Promise.all(
    Object.values(stagedWorkspace).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  const skillOverrides = await copySkillOverrides(
    workspace.skillsRoot,
    stagedWorkspace.skillsRoot,
  );

  return {
    orgRoot: stageOrgRoot,
    workspace: stagedWorkspace,
    skillOverrides,
  };
}

/**
 * Build the `runCore` the launcher injects into runChatTurn: run the
 * agent loop in an OpenShell sandbox.
 * The host-side prologue (prompt build) and epilogue (fence handling +
 * persistence) stay in runChatTurn around this call. Shared by the worker
 * (channel runs) and the web route (interactive chat) — both are control-plane
 * hosts that launch the sandbox but never run the agent loop themselves.
 */
export function makeSandboxRunCore(opts: SandboxLauncherOptions): RunCore {
  return makeSandboxCore(opts, "work") as RunCore;
}

export function makeSandboxWorkflowRunCore(
  opts: SandboxLauncherOptions,
): RunWorkflowCore {
  return makeSandboxCore(opts, "workflow") as RunWorkflowCore;
}

/** Run one non-interactive backend turn inside OpenShell. */
export function makeSandboxJobRunCore(
  opts: SandboxLauncherOptions,
): RunJobCore {
  return makeSandboxCore(opts, "agent-job") as RunJobCore;
}

/**
 * Wrap a configured backend so every run happens in an OpenShell sandbox.
 * The wrapper accepts only serializable, non-interactive run options; tools
 * are derived from `access` inside the box instead of trusting caller-supplied
 * MCP servers or permission callbacks.
 */
export async function sandboxAgentBackendForJob(opts: {
  backend: AgentBackend;
  orgId: string;
  runId: string;
  workspace: AgentWorkspace;
  access?: AgentJobAccess;
}): Promise<AgentBackend> {
  const access = opts.access ?? {};
  const needsBroker = access.graphjinRead || access.memorySearch;
  const broker = needsBroker
    ? await import("./broker").then(({ ensureAgentBroker }) =>
        ensureAgentBroker(),
      )
    : undefined;
  if (needsBroker && !broker) {
    throw new Error("agent job capabilities require the OpenNeko broker");
  }
  const runCore = makeSandboxJobRunCore(sandboxLauncherOptionsFromEnv(broker));

  return {
    id: opts.backend.id,
    model: opts.backend.model,
    capabilities: opts.backend.capabilities,
    async run(run): Promise<AgentRunResult> {
      const workspace = run.workspace ?? opts.workspace;
      if (workspace.orgRoot !== opts.workspace.orgRoot) {
        throw new Error("agent job attempted to replace its isolated workspace");
      }
      if (
        run.mcpServers ||
        run.canUseTool ||
        run.onElicitation ||
        run.hooks ||
        run.agents ||
        run.allowedTools
      ) {
        throw new Error(
          "agent job tools must be declared through the OpenShell access envelope",
        );
      }
      if (run.signal) {
        throw new Error("agent job AbortSignal forwarding is not supported");
      }
      return runCore({
        backend: opts.backend,
        orgId: opts.orgId,
        runId: opts.runId,
        workspace,
        run,
        access,
        emit: async (event) => {
          await run.onEvent?.(event);
        },
      });
    },
  };
}

function makeSandboxCore(
  opts: SandboxLauncherOptions,
  kind: SandboxRunKind,
): (input: SandboxRunInput) => Promise<AgentRunResult> {
  const cli = opts.cli ?? "openshell";
  const log = opts.onLog ?? ((l: string) => console.log(`[agent-sandbox] ${l}`));

  const gatewayArgs = opts.gatewayName
    ? ["--gateway", opts.gatewayName]
    : opts.gatewayEndpoint
      ? ["--gateway-endpoint", opts.gatewayEndpoint]
      : [];

  const runCleanup = (args: string[], timeoutMs: number): Promise<string> =>
    runProcessOnce(cli, [...gatewayArgs, ...args], timeoutMs);

  return async function sandboxRunCore(
    input: SandboxRunInput,
  ): Promise<AgentRunResult> {
    const isJob = kind === "agent-job";
    const jobInput = isJob ? (input as RunJobAgentBackendInput) : null;
    const signal = isJob
      ? undefined
      : (input as RunAgentBackendInput | RunWorkflowAgentBackendInput).signal;
    if (signal?.aborted) throw abortError();
    const run = (args: string[], timeoutMs: number): Promise<string> =>
      runProcessOnce(cli, [...gatewayArgs, ...args], timeoutMs, signal);
    const inputPrompt = jobInput?.run.prompt ??
      (input as RunAgentBackendInput | RunWorkflowAgentBackendInput).prompt;
    const name = `${isJob ? "job" : "work"}-${input.runId}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 60);

    // The box is a separate filesystem; the host workspace path (~/.config/… or
    // /Users/…) can't be recreated under the sandbox user's home. Upload the
    // workspace under /sandbox and remap every workspace path + the prompt from
    // the host orgRoot prefix to the box prefix (all roots are under orgRoot).
    const hostOrgRoot = input.workspace.orgRoot;
    const boxOrgRoot = path.posix.join("/sandbox", path.basename(hostOrgRoot));
    const toBox = (s: string): string => s.split(hostOrgRoot).join(boxOrgRoot);
    const boxWorkspace = Object.fromEntries(
      Object.entries(input.workspace).map(([k, v]) => [
        k,
        typeof v === "string" ? toBox(v) : v,
      ]),
    ) as RunAgentBackendInput["workspace"];

    // Non-interactive jobs never receive direct source egress or a GraphJin
    // token. Their graphjinRead capability is a brokered query-only MCP tool.
    const graphjinEnabled = !isJob;

    // Job agents are always read-only. Interactive/workflow turns retain
    // their existing actor-policy grant resolution.
    const graphjinWriteGrants =
      graphjinEnabled && !isJob
        ? await resolveRunGraphjinGrants(input.orgId, input.runId)
        : [];

    // GJ6: the box must reach the org's GraphJin server — resolved here
    // (host-side, where the DB lives) both for the egress rule and for the
    // in-box client.json (entry.ts rewrites loopback to the host alias).
    const dataEgress: Awaited<ReturnType<typeof resolveDataSourceEgress>> = graphjinEnabled
      ? await resolveDataSourceEgress(
          input.orgId,
          (() => {
            const binary =
              opts.graphjinBinaryInBox ?? "/usr/local/bin/graphjin";
            return binary.endsWith("/graphjin")
              ? [binary, `${binary}.real`]
              : [binary];
          })(),
        )
      : { rules: [] };
    const graphjinClientConfig = graphjinEnabled
      ? await readRunGraphjinClientConfig(input.workspace.runRoot)
      : null;

    const threadId = isJob
      ? `agent-job:${input.runId}`
      : (input as RunAgentBackendInput | RunWorkflowAgentBackendInput).threadId;
    const message = isJob
      ? jobInput?.run.userMessage ?? ""
      : (input as RunAgentBackendInput | RunWorkflowAgentBackendInput).userMessage;

    const job = {
      kind,
      orgId: input.orgId,
      threadId,
      runId: input.runId,
      message,
      prompt: toBox(inputPrompt),
      backendId: input.backend.id,
      // claude-agent reconstructs in-box and validates it has a Claude model;
      // hermes reads its model from config.yaml, so this is undefined there.
      model: input.backend.model,
      workspace: boxWorkspace,
      graphjinEnabled,
      ...(kind === "work"
        ? {
            backendState: (input as RunAgentBackendInput).backendState,
            pluginActions: (input as RunAgentBackendInput).pluginActions,
            sourceConfigEnabled:
              (input as RunAgentBackendInput).sourceConfigEnabled ?? false,
            // Channel render intent — gates the in-box render tool (see
            // docs/PER_CHANNEL_RENDERING.md). Default true if absent.
            wantsCards: (input as RunAgentBackendInput).wantsCards ?? true,
          }
        : kind === "workflow"
          ? {
            workflowRunId: (input as RunWorkflowAgentBackendInput).workflowRunId,
            mode: (input as RunWorkflowAgentBackendInput).mode,
            triggeredByObservationId:
              (input as RunWorkflowAgentBackendInput).triggeredByObservationId ?? null,
            }
          : {
              agentAccess: jobInput?.access ?? {},
              agentRun: serializableAgentRunOptions(jobInput?.run ?? { prompt: inputPrompt }),
            }),
      ...(graphjinWriteGrants.length > 0 ? { graphjinWriteGrants } : {}),
      ...(dataEgress.serverUrl ? { graphjinServerUrl: dataEgress.serverUrl } : {}),
      ...(graphjinClientConfig ? { graphjinClientConfig } : {}),
    };

    // claude's MCP tools reach the control plane via the broker — node's
    // fetch routes through the egress proxy. Keep this endpoint scoped to the
    // node binary in the creation-time policy.
    const brokerEgress: SandboxEgressRule[] = opts.brokerUrl
      ? (() => {
          const u = new URL(opts.brokerUrl);
          return [
            {
              host: u.hostname,
              port: Number(u.port) || 80,
              binary: "/usr/local/bin/node",
            },
          ];
        })()
      : [];
    const egressRules: SandboxEgressRule[] = [
      ...(opts.modelEgress ?? []),
      ...brokerEgress,
      ...dataEgress.rules,
    ];

    const stageDir = await mkdtemp(path.join(tmpdir(), "oss-agent-"));
    let sandboxCreated = false;
    try {
      await input.emit({
        type: "status",
        message: "Preparing secure agent workspace…",
      });
      const staged = await stageSandboxWorkspace(input.workspace, stageDir);
      const stageRuntimeRoot = path.join(
        staged.workspace.runRoot,
        SANDBOX_RUNTIME_DIR,
      );
      await mkdir(stageRuntimeRoot, { recursive: true });
      const jobFile = path.join(stageRuntimeRoot, "job.json");
      await writeFile(jobFile, JSON.stringify(job));
      const hermesStage = opts.hermesHomeHostPath
        ? await stageKeylessHermesHome(
            opts.hermesHomeHostPath,
            path.join(stageRuntimeRoot, "hermes-home"),
          )
        : null;
      const policyFile = path.join(stageDir, "policy.json");
      await writeFile(
        policyFile,
        JSON.stringify(buildSandboxPolicy(egressRules)),
      );
      const sandboxJobPath = path.posix.join(
        boxWorkspace.runRoot,
        SANDBOX_RUNTIME_DIR,
        "job.json",
      );
      const sandboxHermesHome = path.posix.join(
        boxWorkspace.runRoot,
        SANDBOX_RUNTIME_DIR,
        "hermes-home",
      );

      await input.emit({
        type: "status",
        message: "Starting secure agent sandbox…",
      });
      await run(
        [
          "sandbox",
          "create",
          "--name",
          name,
          "--from",
          opts.agentImage,
          "--no-tty",
          "--no-auto-providers",
          ...(opts.modelProvider ? ["--provider", opts.modelProvider] : []),
          "--policy",
          policyFile,
          "--upload",
          // OpenShell nests basename(LOCAL_PATH) under SANDBOX_PATH.
          `${staged.orgRoot}:${path.posix.dirname(boxOrgRoot)}`,
          "--no-git-ignore",
          "--",
          "node",
          "--version",
        ],
        180_000,
      );
      sandboxCreated = true;

      log(
        `agent sandbox ready: ${name} (backend=${input.backend.id}, kind=${kind}, ` +
          `graphjin=${graphjinEnabled}, skill_overrides=${staged.skillOverrides.length})`,
      );
      await input.emit({ type: "status", message: "Launching agent…" });
      return await execAndStream(
        cli,
        gatewayArgs,
        name,
        buildInnerCommand({
          env: {
            OPENNEKO_RUN_JOB_FILE: sandboxJobPath,
            ...(opts.brokerUrl ? { OPENNEKO_BROKER_URL: opts.brokerUrl } : {}),
            ...(opts.brokerUrl && opts.brokerTokenFor
              ? {
                  OPENNEKO_BROKER_TOKEN: opts.brokerTokenFor({
                    runId: input.runId,
                    orgId: input.orgId,
                  }),
                }
              : {}),
            ...(opts.env ?? {}),
            ...(hermesStage ? { HERMES_HOME: sandboxHermesHome } : {}),
          },
          keyAliases: opts.keyAliases,
        }),
        input.emit,
        // Must outlive the in-box turn budget with margin, so a long turn
        // dies as the backend's honest timeout error — not an opaque
        // exec-stream kill from out here.
        opts.execTimeoutMs ??
          (jobInput?.run.timeoutMs ?? agentTurnTimeoutMs()) + 120_000,
        signal,
      );
    } finally {
      opts.brokerRelease?.(input.runId);
      // Pull artifacts the agent wrote in the box back to the host run dir
      // before deleting the box — otherwise the file-serving endpoint reads an
      // empty host dir and 404s the download. Best-effort, and runs even when
      // the turn errored or timed out (the box is still alive here), so a
      // partial artifact from a long run isn't lost.
      if (sandboxCreated && !isJob && !signal?.aborted) {
        await mkdir(input.workspace.artifactRoot, { recursive: true }).catch(
          () => {},
        );
        await runCleanup(
          [
            "sandbox",
            "download",
            name,
            boxWorkspace.artifactRoot,
            input.workspace.artifactRoot,
          ],
          120_000,
        ).catch((e) => log(`artifact pull-back skipped: ${(e as Error).message}`));
      }
      // The sandbox is the process-tree boundary. Deleting it terminates the
      // backend plus every child/sub-agent, and cleanup must not inherit the
      // already-aborted run signal.
      if (sandboxCreated) {
        await runCleanup(["sandbox", "delete", name], 60_000).catch(() => {});
      }
      await rm(stageDir, { recursive: true, force: true });
    }
  };
}

/** `policy update` adding the model endpoint(s) scoped to the backend binary. */
/** GJ6: the org's GraphJin host as a per-run egress allow entry. Best-effort. */
async function resolveDataSourceEgress(
  orgId: string,
  graphjinBinaries: readonly string[],
): Promise<{
  rules: Array<{ host: string; binary: string; port?: number }>;
  serverUrl?: string;
}> {
  try {
    const { data_source, db, desc, eq } = await import("@neko/db");
    const [src] = await db()
      .select({ mcpUrl: data_source.mcp_url })
      .from(data_source)
      .where(eq(data_source.org_id, orgId))
      .orderBy(desc(data_source.is_default), data_source.created_at)
      .limit(1);
    if (!src?.mcpUrl) return { rules: [] };
    const u = new URL(src.mcpUrl);
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    // A host-local server (localhost or a compose-internal name like
    // `graphjin`) is only reachable from the box via the gateway's host
    // alias — the proxy refuses loopback endpoint rules outright and its
    // SSRF check rejects names resolving to private compose IPs.
    const host = isHostLocalName(u.hostname) ? SANDBOX_HOST_ALIAS : u.hostname;
    return {
      rules: graphjinBinaries.map((binary) => ({ host, port, binary })),
      serverUrl: src.mcpUrl,
    };
  } catch (err) {
    console.warn(
      `[agent-sandbox] data-source egress lookup failed: ${err instanceof Error ? err.message : err}`,
    );
    return { rules: [] };
  }
}

async function readRunGraphjinClientConfig(
  runRoot: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!runRoot) return null;
  const candidates = [
    path.join(runRoot, "gj-auth", "graphjin", "client.json"),
    path.join(runRoot, "gj-auth", ".config", "graphjin", "client.json"),
    path.join(
      runRoot,
      "gj-auth",
      "Library",
      "Application Support",
      "graphjin",
      "client.json",
    ),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** GJ5 host-side grant resolution for the in-box guard rebuild. Best-effort. */
async function resolveRunGraphjinGrants(
  orgId: string,
  runId: string,
): Promise<string[]> {
  try {
    const { getWorkRunActor } = await import("./personas");
    const { resolveGraphjinWriteGrants } = await import(
      "./graphjin-actor-guard"
    );
    const actor = await getWorkRunActor(runId);
    return await resolveGraphjinWriteGrants(orgId, actor);
  } catch {
    return [];
  }
}

export function buildModelEgressArgs(
  name: string,
  egress: ReadonlyArray<{ host: string; binary: string; port?: number }>,
): string[] | null {
  if (egress.length === 0) return null;
  const args = ["policy", "update", name];
  for (const { host, port } of egress) {
    args.push("--add-endpoint", `${host}:${port ?? 443}:read-write:rest:enforce`);
  }
  for (const { binary } of egress) args.push("--binary", binary);
  for (const { host, port } of egress)
    args.push("--add-allow", `${host}:${port ?? 443}:*:/**`);
  args.push("--wait", "--timeout", "60");
  return args;
}

export function buildScopedEgressArgs(
  name: string,
  egress: ReadonlyArray<{ host: string; binary: string; port?: number }>,
): string[][] {
  const byBinary = new Map<
    string,
    Array<{ host: string; binary: string; port?: number }>
  >();
  for (const rule of egress) {
    const rules = byBinary.get(rule.binary) ?? [];
    rules.push(rule);
    byBinary.set(rule.binary, rules);
  }
  return Array.from(byBinary.values()).flatMap((rules) => {
    const args = buildModelEgressArgs(name, rules);
    return args ? [args] : [];
  });
}

/**
 * Build the OpenShell runtime deps for runChatTurn from env. SEC9: OpenShell
 * is the only agent runtime — every production host injects this runCore;
 * tests inject their own in-process runCore via deps. Env-wired for now;
 * per-org auto-sync (provider/egress/key-var from the org row) is a follow-up.
 *
 * `broker` (optional) wires the claude MCP-tool path: the caller starts a host
 * broker (startAgentBroker) bound to its control plane and passes the handle so
 * the sandbox can reach the control plane mid-turn. Omit for the hermes-only
 * path (hermes emits fences parsed host-side; it needs no broker).
 */
export function agentRuntimeDepsFromEnv(broker?: {
  url: string;
  tokenFor: (binding: { runId: string; orgId: string }) => string;
  release?: (runId: string) => void;
}): Pick<Partial<RunChatTurnDeps>, "runCore"> {
  return {
    runCore: makeSandboxRunCore(sandboxLauncherOptionsFromEnv(broker)),
  };
}

export function workflowRuntimeDepsFromEnv(broker?: {
  url: string;
  tokenFor: (binding: { runId: string; orgId: string }) => string;
  release?: (runId: string) => void;
}): Pick<Partial<RunWorkflowTurnDeps>, "runCore"> {
  return {
    runCore: makeSandboxWorkflowRunCore(sandboxLauncherOptionsFromEnv(broker)),
  };
}

function sandboxLauncherOptionsFromEnv(broker?: {
  url: string;
  tokenFor: (binding: { runId: string; orgId: string }) => string;
  release?: (runId: string) => void;
}): SandboxLauncherOptions {
  // Comma-separated: the model endpoint AND any resolution hosts (hermes needs
  // models.dev), all scoped to the backend's one connecting binary.
  const hosts = (process.env.OPENNEKO_AGENT_MODEL_HOST ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const binary = process.env.OPENNEKO_AGENT_MODEL_BINARY;
  // OpenShell injects the credential under the credential NAME (default
  // `api_key`); alias it to the env var the backend reads (the hermes
  // provider→key map, e.g. GEMINI_API_KEY). The proxy swaps in the real key on
  // egress, so the box only ever holds the placeholder.
  const keyEnv = process.env.OPENNEKO_AGENT_MODEL_KEY_ENV;
  const credName = process.env.OPENNEKO_AGENT_MODEL_CREDENTIAL || "api_key";
  return {
    agentImage: process.env.OPENNEKO_AGENT_IMAGE ?? "ghcr.io/open-neko/agent:latest",
    gatewayName: process.env.OPENSHELL_GATEWAY || undefined,
    gatewayEndpoint: process.env.OPENSHELL_GATEWAY_ENDPOINT || undefined,
    modelProvider: process.env.OPENNEKO_AGENT_MODEL_PROVIDER || undefined,
    modelEgress: binary ? hosts.map((host) => ({ host, binary })) : [],
    keyAliases: keyEnv ? [{ from: credName, to: keyEnv }] : undefined,
    hermesHomeHostPath: process.env.OPENNEKO_AGENT_HERMES_HOME || undefined,
    graphjinBinaryInBox:
      process.env.OPENNEKO_AGENT_GRAPHJIN_BINARY || undefined,
    brokerUrl: broker?.url,
    brokerTokenFor: broker?.tokenFor,
    brokerRelease: broker?.release,
  };
}

// Generic provider profile: holds just the model credential. The proxy
// substitutes the injected `openshell:resolve:env:…` placeholder wherever the
// agent puts it (gemini's ?key= query, claude's x-api-key header — both work,
// verified), so endpoints/binaries aren't needed here; egress is applied
// per-run by the launcher (modelEgress). One profile covers every provider.
const OPENNEKO_AGENT_PROFILE_ID = "openneko-agent";
const OPENNEKO_AGENT_PROFILE_YAML = `id: ${OPENNEKO_AGENT_PROFILE_ID}
display_name: OpenNeko Agent
description: OpenNeko agent model credential (generic; egress applied per-run)
category: agent
credentials:
- name: api_key
  description: model API key — proxy substitutes the placeholder on egress
  env_vars:
  - MODEL_API_KEY
  required: true
  auth_style: query
  header_name: ''
  query_param: key
endpoints: []
binaries: []
inference_capable: false
discovery:
  credentials:
  - api_key
`;

/**
 * Ensure a gateway-side OpenShell provider exists holding the org's model key,
 * so the egress proxy can inject it (the key never enters the box). Idempotent:
 * registers the generic profile, then creates-or-updates the named provider.
 * Run at worker startup (provisionHostConfig) — replaces the manual
 * `openshell provider create` step. Egress + the key-env alias stay with the
 * launcher; this only owns the credential.
 */
export async function ensureOpenShellProvider(opts: {
  providerName: string;
  apiKey: string;
  cli?: string;
  gatewayName?: string;
  gatewayEndpoint?: string;
}): Promise<void> {
  const cli = opts.cli ?? "openshell";
  const gatewayArgs = opts.gatewayName
    ? ["--gateway", opts.gatewayName]
    : opts.gatewayEndpoint
      ? ["--gateway-endpoint", opts.gatewayEndpoint]
      : [];
  const run = (args: string[]): Promise<string> =>
    runProcessOnce(cli, [...gatewayArgs, ...args], 60_000);

  const dir = await mkdtemp(path.join(tmpdir(), "oss-profile-"));
  try {
    const file = path.join(dir, `${OPENNEKO_AGENT_PROFILE_ID}.yaml`);
    await writeFile(file, OPENNEKO_AGENT_PROFILE_YAML);
    // Import is upsert-ish; tolerate "already registered".
    await run(["provider", "profile", "import", "--file", file]).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const credential = `api_key=${opts.apiKey}`;
  // create on first run; update (refresh key) when it already exists.
  await run([
    "provider",
    "create",
    "--name",
    opts.providerName,
    "--type",
    OPENNEKO_AGENT_PROFILE_ID,
    "--credential",
    credential,
  ]).catch(() => run(["provider", "update", opts.providerName, "--credential", credential]));
}

/**
 * Mirror a host HERMES_HOME into `destination` KEYLESS: copy
 * config.yaml, write an empty `.env`. hermes reads `.env` before the process
 * env, so an empty `.env` lets the proxy-injected key (keyAliases) win — and
 * the real key never lands in the box.
 */
async function stageKeylessHermesHome(
  hostPath: string,
  destination: string,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  const config = await readFile(path.join(hostPath, "config.yaml"), "utf8");
  await writeFile(path.join(destination, "config.yaml"), config);
  await writeFile(path.join(destination, ".env"), "");
  return destination;
}

function buildInnerCommand(o: {
  env: Record<string, string>;
  keyAliases?: ReadonlyArray<{ from: string; to: string }>;
}): string {
  const exports = Object.entries(o.env)
    .map(([k, v]) => {
      if (!SHELL_KEY_RX.test(k)) throw new Error(`bad env key ${k}`);
      return `export ${k}=${shellQuote(v)}`;
    })
    .join("; ");
  // Reference the OpenShell-injected var at runtime ("$from") — never a value.
  const aliases = (o.keyAliases ?? [])
    .map(({ from, to }) => {
      if (!SHELL_VARNAME_RX.test(from) || !SHELL_VARNAME_RX.test(to)) {
        throw new Error(`bad key alias ${from}->${to}`);
      }
      return `export ${to}="$${from}"`;
    })
    .join("; ");
  // cd into /app so `node --import tsx/esm` resolves tsx from /app/node_modules
  // (the image WORKDIR is the sandbox home /sandbox, which has no node_modules).
  // entry.ts reads its job by absolute path and the backend sets hermes's cwd
  // itself, so the node process cwd is free to be /app.
  const parts = [exports, aliases, "cd /app", `exec node --import tsx/esm ${AGENT_ENTRY}`];
  return parts.filter(Boolean).join("; ");
}

function runProcessOnce(
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      fail(abortError());
    };
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`openshell ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      fail(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 && !stdout.trim()) {
        // Redact secret-bearing values (--credential name=value) — this
        // message reaches console logs.
        const shown = args
          .map((a, i) =>
            args[i - 1] === "--credential" ? a.replace(/=.*/u, "=[redacted]") : a,
          )
          .join(" ");
        reject(
          new Error(
            `openshell ${shown.slice(0, 160)} exited ${code}; stderr=${stderr.slice(0, 400)}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * exec entry.ts and stream its tagged stdout: EVENT_MARKER lines → emit (host
 * scrubs + persists → web UI), the RESULT_MARKER line → the AgentRunResult.
 */
function execAndStream(
  cli: string,
  gatewayArgs: string[],
  name: string,
  innerCmd: string,
  emit: (event: AgentEvent) => Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  return new Promise((resolve, reject) => {
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const child = spawn(
      cli,
      [
        ...gatewayArgs,
        "sandbox",
        "exec",
        "-n",
        name,
        "--no-tty",
        "--timeout",
        String(timeoutSec),
        "--",
        "sh",
        "-c",
        innerCmd,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let result: AgentRunResult | undefined;
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill("SIGKILL");
      reject(err);
    };
    const onAbort = () => fail(abortError());
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      const ev = line.indexOf(EVENT_MARKER);
      if (ev >= 0) {
        try {
          void emit(JSON.parse(line.slice(ev + EVENT_MARKER.length)) as AgentEvent);
        } catch {
          /* ignore a partial/garbled event line */
        }
        return;
      }
      const rs = line.indexOf(RESULT_MARKER);
      if (rs >= 0) {
        try {
          result = JSON.parse(line.slice(rs + RESULT_MARKER.length)) as AgentRunResult;
        } catch {
          /* ignore */
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    timer = setTimeout(() => {
      fail(new Error(`agent sandbox exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      fail(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result) return resolve(result);
      reject(
        new Error(
          `agent sandbox exited ${code} without a result line; stderr=${stderr.slice(0, 500)}`,
        ),
      );
    });
  });
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}
