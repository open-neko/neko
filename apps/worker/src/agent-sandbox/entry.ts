import { existsSync, readFileSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  makeAgentBackend,
  type AgentBackendId,
  type AgentEvent,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentWorkspace,
} from "@neko/llm";
import { runWorkflowAgentBackend } from "@neko/llm/workflows";
import {
  ensureGraphjinGuard,
  buildGraphjinAgentServer,
  buildGraphjinReadServer,
  buildWorkMemoryServer,
  materializeBuiltinSkills,
  resolveBinaryOnPath,
  runAgentBackend,
  sandboxReachableUrl,
  type RunAgentBackendInput,
} from "@neko/llm/work";
import { BrokerControlPlane } from "./broker-client";
import { EVENT_MARKER, RESULT_MARKER } from "./protocol";

/**
 * Runs INSIDE the agent's OpenShell sandbox (Phase 3). The launcher (work-run)
 * does the DB-bound prologue on the host, uploads the job + workspace, and
 * exec's this. We reconstruct the backend (with a PLACEHOLDER key — the real
 * key is injected by the OpenShell egress proxy, never here), run the agent
 * loop, and STREAM events back as tagged stdout lines that the launcher relays
 * to the host (which scrubs + persists). The model key never enters the box.
 *
 * Events go over stdout rather than a network broker because `openshell
 * sandbox exec` streams stdout to the host in real time — so hermes (which has
 * no MCP tools and emits its action/workflow fences for host-side parsing)
 * needs no broker at all. claude-agent's MCP tools DO need the control plane
 * mid-turn, so a BrokerControlPlane is wired when broker coords are present.
 */
interface SandboxJob {
  kind?: "work" | "workflow" | "agent-job";
  orgId: string;
  threadId: string;
  runId: string;
  message: string;
  prompt: string;
  backendId: AgentBackendId;
  model?: string;
  backendState?: Record<string, unknown>;
  pluginActions?: RunAgentBackendInput["pluginActions"];
  sourceConfigEnabled?: boolean;
  dataSurface?: RunAgentBackendInput["dataSurface"];
  wantsCards?: boolean;
  workflowRunId?: string;
  mode?: "live" | "headless";
  triggeredByObservationId?: string | null;
  workspace: AgentWorkspace;
  /** Whether the raw GraphJin binary is replaced with the guarded client. */
  graphjinEnabled?: boolean;
  /** Install a deny wrapper even though no customer GraphJin egress/token exists. */
  graphjinDenied?: boolean;
  /** Explicit least-privilege envelope for non-interactive agent jobs. */
  agentAccess?: {
    graphjinRead?: boolean;
    graphjinAgent?: boolean;
    memorySearch?: boolean;
  };
  agentRun?: Pick<
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
  /** GJ5: policy write grants resolved host-side (the box has no DB). */
  graphjinWriteGrants?: string[];
  /** GJ6: the org's GraphJin MCP URL, resolved host-side. Lets the box
   *  build a client.json even in legacy (token-less) mode. */
  graphjinServerUrl?: string;
  /** GJ6/GJ4: host-side per-run GraphJin client config ({server, token, ...}).
   *  The sandbox rewrites only server reachability and preserves the actor token. */
  graphjinClientConfig?: Record<string, unknown>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`agent-sandbox: missing required env ${name}`);
  return value;
}

function emitLine(marker: string, obj: unknown): void {
  // One JSON object per line, newline-delimited, with a leading newline so a
  // marker never glues onto unflushed backend output on the same line.
  process.stdout.write(`\n${marker}${JSON.stringify(obj)}\n`);
}

function loadJob(): SandboxJob {
  // Large prompts are uploaded as a file to dodge env/ARG_MAX limits; small
  // jobs may come inline via OPENNEKO_RUN_JOB.
  const file = process.env.OPENNEKO_RUN_JOB_FILE;
  const raw = file ? readFileSync(file, "utf8") : requireEnv("OPENNEKO_RUN_JOB");
  return JSON.parse(raw) as SandboxJob;
}

export async function main(): Promise<void> {
  const job = loadJob();
  // The launcher transfers only custom or modified skill directories. Fill in
  // unchanged built-ins from the agent image, then expose the same catalog to
  // Claude's native project skill discovery. Skill bodies remain filesystem
  // resources and are read only when the agent chooses one.
  await materializeBuiltinSkills(
    job.workspace.skillsRoot,
    job.workspace.claudeProjectRoot,
  );
  // Claude discovers project skills through `.claude/skills`; Hermes scans
  // HERMES_HOME/skills. Point both backends at the same per-run catalog so a
  // required skill staged by the host is visible to Hermes' native skill tool.
  if (job.backendId === "hermes" && process.env.HERMES_HOME) {
    const hermesSkillsRoot = join(process.env.HERMES_HOME, "skills");
    await rm(hermesSkillsRoot, { recursive: true, force: true });
    await symlink(job.workspace.skillsRoot, hermesSkillsRoot, "dir");
  }
  const brokerUrl = process.env.OPENNEKO_BROKER_URL;
  const brokerToken = process.env.OPENNEKO_BROKER_TOKEN;

  const backend = makeAgentBackend({
    id: job.backendId,
    model: job.model,
    apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY,
  });

  // MCP tools reach the control plane mid-turn through the broker — claude
  // via in-process SDK servers, hermes via stdio bridge children that ACP
  // launches from this path.
  const controlPlane =
    brokerUrl && brokerToken
      ? new BrokerControlPlane(brokerUrl, brokerToken)
      : undefined;
  if (brokerUrl && brokerToken) {
    // Prefer the image-baked plain-JS bundle: hermes spawns one bridge
    // process per server, and the tsx loader costs ~300MB RSS each vs
    // ~80MB bundled. The .ts fallback keeps tests + dev images working.
    const bundled = new URL(
      "../../dist/agent-sandbox/mcp-bridge.js",
      import.meta.url,
    ).pathname;
    process.env.OPENNEKO_MCP_BRIDGE = existsSync(bundled)
      ? bundled
      : new URL("./mcp-bridge.ts", import.meta.url).pathname;
  }

  const emit = (event: AgentEvent): Promise<void> => {
    emitLine(EVENT_MARKER, event);
    return Promise.resolve();
  };

  // GJ6: the workspace's bin/graphjin wrapper was generated host-side with
  // host paths baked in — rebuild it for the box, pinned at the uploaded
  // per-run client.json (GJ4 token) and carrying the host-resolved policy
  // grants (GJ5). Without a graphjin binary in the image this is a no-op.
  const graphjinEnabled =
    job.kind === "agent-job"
      ? job.graphjinEnabled === true
      : job.graphjinEnabled !== false;
  const graphjinBinary = graphjinEnabled
    || job.graphjinDenied === true
    ? await resolveBinaryOnPath("graphjin")
    : null;
  if (graphjinBinary) {
    const gjAuth = join(job.workspace.runRoot, "gj-auth");
    const clientJsonPath = join(gjAuth, "graphjin", "client.json");
    const uploadedConfig = existsSync(clientJsonPath)
      ? JSON.parse(readFileSync(clientJsonPath, "utf8")) as Record<string, unknown>
      : null;
    const clientConfig = sandboxGraphjinClientConfig(
      job.graphjinClientConfig ?? uploadedConfig,
      job.graphjinServerUrl,
    );
    let hasRunAuth = false;
    if (clientConfig) {
      await mkdir(join(gjAuth, "graphjin"), { recursive: true });
      await writeFile(clientJsonPath, JSON.stringify(clientConfig));
      await chmod(clientJsonPath, 0o600).catch(() => {});
      hasRunAuth = true;
    }
    await mkdir(job.workspace.binRoot, { recursive: true });
    // Defense-in-depth: the model sometimes ignores the "query only via the
    // shell tool" contract and shells out to `graphjin` from execute_code (a
    // Python subprocess with a minimal PATH), hitting the raw binary at
    // /usr/local/bin/graphjin with the wrong auth — which fails and sends it
    // into a retry loop, and would bypass the mutation gate. Move the real
    // binary aside and shadow the standard PATH entry with the guard wrapper, so
    // ANY `graphjin` invocation (any PATH) gets the guarded, correctly-authed
    // CLI (the wrapper exports the run's XDG_CONFIG_HOME regardless of caller).
    let realBinary = graphjinBinary;
    if (graphjinBinary === "/usr/local/bin/graphjin") {
      try {
        await rename("/usr/local/bin/graphjin", "/usr/local/bin/graphjin.real");
        realBinary = "/usr/local/bin/graphjin.real";
      } catch {
        /* not writable / already shadowed — fall back to binRoot-only guard */
      }
    }
    await ensureGraphjinGuard(job.workspace.binRoot, realBinary, {
      ...(hasRunAuth ? { xdgConfigHome: gjAuth } : {}),
      ...(job.graphjinWriteGrants?.length
        ? { allowSubcommands: job.graphjinWriteGrants }
        : {}),
      ...(job.graphjinDenied ? { denyAll: true } : {}),
    });
    if (realBinary === "/usr/local/bin/graphjin.real") {
      // The move vacated /usr/local/bin/graphjin — point it at the guard wrapper.
      await symlink(
        join(job.workspace.binRoot, "graphjin"),
        "/usr/local/bin/graphjin",
      ).catch(() => {});
    }
    // The backend prepends binRoot to PATH for its children, but hermes'
    // terminal tool spawns LOGIN shells (`bash -lic`) and /etc/profile resets
    // PATH — silently un-guarding `graphjin`. Login shells re-source these
    // files after the reset, so the wrapper wins the lookup again.
    const pathLine = `\nexport PATH="${job.workspace.binRoot}:$PATH"\n`;
    for (const rc of [".bash_profile", ".profile", ".bashrc"]) {
      await appendFile(join(homedir(), rc), pathLine).catch(() => {});
    }
  }

  const kind = job.kind ?? "work";
  let result: AgentRunResult;
  if (kind === "agent-job") {
    const graphjinRead = job.agentAccess?.graphjinRead === true;
    const graphjinAgent = job.agentAccess?.graphjinAgent === true;
    const memorySearch = job.agentAccess?.memorySearch === true;
    if ((graphjinRead || graphjinAgent || memorySearch) && !controlPlane) {
      throw new Error("agent-sandbox: brokered job capability missing broker");
    }
    const mcpServers =
      graphjinRead || graphjinAgent || memorySearch
        ? {
            ...(graphjinRead
              ? {
                  neko_graphjin: buildGraphjinReadServer({
                    orgId: job.orgId,
                    controlPlane,
                  }),
                }
              : {}),
            ...(graphjinAgent
              ? {
                  neko_graphjin_agent: buildGraphjinAgentServer({
                    orgId: job.orgId,
                    runId: job.runId,
                    controlPlane,
                  }),
                }
              : {}),
            ...(memorySearch
              ? {
                  neko_memory: buildWorkMemoryServer(
                    { orgId: job.orgId, runId: job.runId },
                    { exposeSave: false, controlPlane },
                  ),
                }
              : {}),
          }
        : undefined;
    const allowedTools =
      backend.id === "claude-agent"
        ? [
            ...(graphjinRead
              ? ["mcp__neko_graphjin__execute_graphql"]
              : []),
            ...(graphjinAgent
              ? ["mcp__neko_graphjin_agent__ask"]
              : []),
            ...(memorySearch ? ["mcp__neko_memory__search"] : []),
          ]
        : undefined;
    result = await backend.run({
      ...(job.agentRun ?? {}),
      prompt: job.prompt,
      userMessage: job.agentRun?.userMessage ?? (job.message || undefined),
      orgId: job.orgId,
      workspace: job.workspace,
      onEvent: emit,
      mcpServers,
      allowedTools,
      wantsCards: false,
      mcpBridgeEnv:
        graphjinRead || graphjinAgent || memorySearch
          ? {
              OPENNEKO_MCP_ORG_ID: job.orgId,
              OPENNEKO_MCP_THREAD_ID: job.threadId,
              OPENNEKO_MCP_RUN_ID: job.runId,
              OPENNEKO_MCP_SKILLS_ROOT: job.workspace.skillsRoot,
              OPENNEKO_MCP_PLUGIN_ACTIONS: "[]",
              OPENNEKO_MCP_MEMORY_READ_ONLY: "1",
            }
          : undefined,
    });
  } else if (kind === "workflow") {
    const workflowRunId = job.workflowRunId;
    if (!workflowRunId) {
      throw new Error("agent-sandbox: workflow job missing workflowRunId");
    }
    result = await runWorkflowAgentBackend({
      backend,
      prompt: job.prompt,
      userMessage: job.message,
      orgId: job.orgId,
      threadId: job.threadId,
      runId: job.runId,
      workflowRunId,
      mode: job.mode ?? "headless",
      triggeredByObservationId: job.triggeredByObservationId ?? null,
      workspace: job.workspace,
      controlPlane,
      emit,
    });
  } else {
    result = await runAgentBackend({
      backend,
      prompt: job.prompt,
      userMessage: job.message,
      orgId: job.orgId,
      threadId: job.threadId,
      runId: job.runId,
      workspace: job.workspace,
      backendState: job.backendState,
      pluginActions: job.pluginActions ?? [],
      sourceConfigEnabled: job.sourceConfigEnabled ?? false,
      dataSurface: job.dataSurface ?? "customer",
      wantsCards: job.wantsCards ?? true,
      controlPlane,
      emit,
    });
  }

  emitLine(RESULT_MARKER, result);
}

function sandboxGraphjinClientConfig(
  config: Record<string, unknown> | null | undefined,
  fallbackServerUrl: string | undefined,
): Record<string, unknown> | null {
  const next = config ? { ...config } : {};
  const server =
    typeof next.server === "string" && next.server.trim()
      ? next.server
      : fallbackServerUrl;
  if (!server) return null;
  return { ...next, server: sandboxReachableUrl(server) };
}

main().catch((err: unknown) => {
  console.error(
    "[agent-sandbox] fatal:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
