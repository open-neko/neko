import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AgentEvent } from "@neko/llm";
import {
  buildAuditViewerServer,
  buildChannelManagerServer,
  buildDataSourceManagerServer,
  buildGraphjinAgentServer,
  buildGraphjinReadServer,
  buildLibraryServer,
  buildPluginActionServer,
  buildPluginManagerServer,
  buildRecordsReadServer,
  buildSkillBuilderServer,
  buildSourceConfigManagerServer,
  buildUserManagerServer,
  buildWorkMemoryServer,
  type PluginActionDescriptor,
} from "@neko/llm/work";
import {
  buildRuleBuilderServer,
  buildWorkflowActionServer,
  buildWorkflowBuilderServer,
  buildWorkflowOutputServer,
} from "@neko/llm/workflows";
import { BrokerControlPlane, postAgentEvents } from "./broker-client";

/**
 * Stdio MCP server for ACP backends (hermes). The agent process can't hand
 * its in-process SDK server instances across a process boundary, so hermes'
 * `session/new` launches THIS script once for all named servers. The bridge
 * rebuilds each logical server in-process and exposes a single multiplexed
 * stdio endpoint bound to the broker control plane (the same path Claude's
 * in-box tools use). Keeping one Node process instead of one per logical MCP
 * server is material: a normal chat turn mounts roughly ten servers.
 *
 * argv[2] = comma-separated server names (agent-core's mcpServers map keys). Per-run context
 * arrives via env (agent-core's mcpBridgeEnv); broker coords are copied into
 * this clean bridge-child env and are not exposed to the model process.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`mcp-bridge: missing required env ${name}`);
  return value;
}

export type BridgeServerContext = {
  orgId: string;
  threadId: string;
  runId: string;
  skillsRoot: string;
  pluginActions: PluginActionDescriptor[];
  controlPlane: BrokerControlPlane;
  brokerUrl?: string;
  brokerToken?: string;
  workflowRunId?: string;
  triggeredByObservationId?: string | null;
  recordScope?: { appId: string; objectApiName: string };
};

export function buildBridgeServer(
  name: string,
  ctx: BridgeServerContext,
): { instance: { connect: (t: Transport) => Promise<void> } } {
  const { orgId, threadId, runId, skillsRoot, pluginActions, controlPlane } = ctx;
  const emit =
    ctx.brokerUrl && ctx.brokerToken
      ? (event: AgentEvent) =>
          postAgentEvents(ctx.brokerUrl!, ctx.brokerToken!, [event])
      : () => {};
  const common = { orgId, runId, emit, controlPlane };
  switch (name) {
    case "neko_graphjin":
      return buildGraphjinReadServer({ orgId, controlPlane });
    case "neko_graphjin_agent":
      return buildGraphjinAgentServer({ orgId, runId, controlPlane });
    case "neko_skills":
      return buildSkillBuilderServer(skillsRoot);
    case "neko_memory":
      return buildWorkMemoryServer(
        { orgId, threadId, runId },
        {
          controlPlane,
          exposeSave: process.env.OPENNEKO_MCP_MEMORY_READ_ONLY !== "1",
        },
      );
    case "neko_library":
      return buildLibraryServer({ orgId, threadId, runId }, { controlPlane });
    case "neko_records":
      return buildRecordsReadServer({
        orgId,
        runId,
        controlPlane,
        ...(ctx.recordScope ? { scope: ctx.recordScope } : {}),
      });
    case "neko_workflow_builder":
      return buildWorkflowBuilderServer({
        orgId,
        createdByThreadId: threadId,
        createdByRunId: runId,
        emit,
        controlPlane,
      });
    case "neko_workflow_output":
      if (!ctx.workflowRunId) {
        throw new Error("mcp-bridge: neko_workflow_output requires workflowRunId");
      }
      return buildWorkflowOutputServer({
        orgId,
        workflowRunId: ctx.workflowRunId,
        workRunId: runId,
        emit,
        controlPlane,
      });
    case "neko_action":
      if (!ctx.workflowRunId) {
        throw new Error("mcp-bridge: neko_action requires workflowRunId");
      }
      return buildWorkflowActionServer({
        orgId,
        workflowRunId: ctx.workflowRunId,
        workRunId: runId,
        triggeredByObservationId: ctx.triggeredByObservationId ?? null,
        emit,
        controlPlane,
      });
    case "neko_rule_builder":
      return buildRuleBuilderServer({
        orgId,
        createdByThreadId: threadId,
        createdByRunId: runId,
        emit,
        controlPlane,
      });
    case "neko_plugin_manager":
      return buildPluginManagerServer(common);
    case "neko_user_manager":
      return buildUserManagerServer(common);
    case "neko_channel_manager":
      return buildChannelManagerServer(common);
    case "neko_data_source_manager":
      return buildDataSourceManagerServer(common);
    case "neko_source_config_manager":
      return buildSourceConfigManagerServer(common);
    case "neko_audit":
      return buildAuditViewerServer({ orgId, runId, controlPlane });
    case "neko_plugin_actions": {
      const server = buildPluginActionServer({
        orgId,
        threadId,
        runId,
        descriptors: pluginActions,
        emit,
        controlPlane,
      });
      if (!server) throw new Error("mcp-bridge: no plugin actions in this run");
      return server;
    }
    default:
      throw new Error(`mcp-bridge: unknown server ${name}`);
  }
}

/**
 * Hermes exposes a tool as `mcp_<server>_<tool>`. Mounting one physical MCP
 * server called `neko` and publishing `<logical-server>_<tool>` therefore
 * preserves the exact model-facing names used before multiplexing:
 *
 *   neko_memory + search -> mcp_neko_memory_search
 */
export function multiplexedToolName(serverName: string, toolName: string): string {
  if (!serverName.startsWith("neko_") || !toolName) {
    throw new Error(`mcp-bridge: cannot multiplex ${serverName}/${toolName}`);
  }
  return `${serverName.slice("neko_".length)}_${toolName}`;
}

/** Build one public MCP server backed by multiple in-process logical servers. */
export async function buildMultiplexedBridgeServer(
  names: readonly string[],
  ctx: BridgeServerContext,
): Promise<{ instance: Server }> {
  if (names.length === 0) throw new Error("mcp-bridge: no servers to multiplex");

  const publicTools: Array<Record<string, unknown> & { name: string }> = [];
  const routes = new Map<
    string,
    { client: Client; originalToolName: string }
  >();

  for (const name of names) {
    const logical = buildBridgeServer(name, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await logical.instance.connect(serverTransport);

    const client = new Client({
      name: `openneko-mcp-multiplexer-${name}`,
      version: "1.0.0",
    });
    await client.connect(clientTransport);
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const publicName = multiplexedToolName(name, tool.name);
      if (routes.has(publicName)) {
        throw new Error(`mcp-bridge: duplicate multiplexed tool ${publicName}`);
      }
      routes.set(publicName, { client, originalToolName: tool.name });
      publicTools.push({ ...tool, name: publicName });
    }
  }

  const instance = new Server(
    { name: "openneko-mcp-multiplexer", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: publicTools,
  }));
  instance.setRequestHandler(CallToolRequestSchema, async (request) => {
    const route = routes.get(request.params.name);
    if (!route) throw new Error(`mcp-bridge: unknown tool ${request.params.name}`);
    return route.client.callTool({
      name: route.originalToolName,
      arguments: request.params.arguments,
    });
  });
  return { instance };
}

/**
 * The egress proxy admits a freshly spawned process with a lag — its first
 * dials get ECONNREFUSED even with an allow rule in place. Poll until the
 * broker answers anything at all (any HTTP status counts) before serving, so
 * the first real tool call rides a warmed path.
 */
async function warmUpBroker(baseUrl: string, name: string): Promise<void> {
  const trail: string[] = [];
  const deadline = Date.now() + 8_000;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const res = await fetch(new URL("/v1/memory/search", baseUrl), {
        method: "POST",
        body: "{}",
      });
      trail.push(`attempt ${attempts}: HTTP ${res.status}`);
      break;
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause?.code;
      trail.push(`attempt ${attempts}: ${cause ?? (err as Error).message}`);
      if (Date.now() > deadline) break; // serve anyway; per-call retries remain
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  // Startup diagnostics, readable mid-run via `sandbox exec` — bridge stderr
  // is swallowed by hermes, so a file is the only visible channel.
  try {
    const envPick = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /OPENNEKO_|PROXY|proxy|NODE_USE/.test(k),
      ),
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      `/tmp/bridge-${name}.log`,
      JSON.stringify({ baseUrl, trail, env: envPick }, null, 1),
    );
  } catch {
    /* diagnostics only */
  }
}

async function main(): Promise<void> {
  const names = [...new Set((process.argv[2] ?? "").split(",").filter(Boolean))];
  if (names.length === 0) throw new Error("mcp-bridge: missing server-name argument");
  const brokerUrl = requireEnv("OPENNEKO_BROKER_URL");
  const brokerToken = requireEnv("OPENNEKO_BROKER_TOKEN");
  await warmUpBroker(brokerUrl, "multiplexed");
  const controlPlane = new BrokerControlPlane(
    brokerUrl,
    brokerToken,
  );
  const server = await buildMultiplexedBridgeServer(names, {
    orgId: requireEnv("OPENNEKO_MCP_ORG_ID"),
    threadId: requireEnv("OPENNEKO_MCP_THREAD_ID"),
    runId: requireEnv("OPENNEKO_MCP_RUN_ID"),
    skillsRoot: requireEnv("OPENNEKO_MCP_SKILLS_ROOT"),
    pluginActions: JSON.parse(
      process.env.OPENNEKO_MCP_PLUGIN_ACTIONS ?? "[]",
    ) as PluginActionDescriptor[],
    controlPlane,
    brokerUrl,
    brokerToken,
    workflowRunId: process.env.OPENNEKO_MCP_WORKFLOW_RUN_ID,
    triggeredByObservationId:
      process.env.OPENNEKO_MCP_TRIGGERED_BY_OBSERVATION_ID ?? null,
    recordScope: process.env.OPENNEKO_MCP_RECORD_SCOPE
      ? (JSON.parse(process.env.OPENNEKO_MCP_RECORD_SCOPE) as {
          appId: string;
          objectApiName: string;
        })
      : undefined,
  });
  await server.instance.connect(new StdioServerTransport());
}

const invokedDirectly =
  process.argv[1]?.endsWith("mcp-bridge.ts") ||
  process.argv[1]?.endsWith("mcp-bridge.js");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(
      "[mcp-bridge] fatal:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}
