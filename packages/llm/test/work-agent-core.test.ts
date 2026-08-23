import { describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentRunOptions,
  AgentWorkspace,
} from "../src/agent-backend";
import type { AgentControlPlane } from "../src/work/control-plane";
import { runAgentBackend } from "../src/work/agent-core";

const workspace: AgentWorkspace = {
  orgRoot: "/tmp/org",
  skillsRoot: "/tmp/org/skills",
  memoryRoot: "/tmp/org/memory",
  knowledgeRoot: "/tmp/org/knowledge",
  uploadsRoot: "/tmp/org/uploads",
  runsRoot: "/tmp/org/runs",
  threadUploadsRoot: "/tmp/org/uploads/thread-1",
  runRoot: "/tmp/org/runs/run-1",
  artifactRoot: "/tmp/org/runs/run-1/artifacts",
  binRoot: "/tmp/org/runs/run-1/bin",
};

// These tests only inspect the MCP server wiring; no tool handler is invoked.
const controlPlane = {} as AgentControlPlane;

describe("runAgentBackend", () => {
  it("mounts actor-scoped native records tools for MCP-capable chat agents", async () => {
    let captured: AgentRunOptions | undefined;
    const backend: AgentBackend = {
      id: "hermes",
      capabilities: {
        mcpTools: true,
        sessionResume: false,
        nativeDelegation: "hermes-delegate-task",
      },
      async run(opts) {
        captured = opts;
        return { status: "completed", finalText: "done" };
      },
    };

    await runAgentBackend({
      backend,
      prompt: "prompt",
      userMessage: "find the camera loan",
      orgId: "org-1",
      threadId: "thread-1",
      runId: "run-1",
      workspace,
      controlPlane,
      pluginActions: [],
      emit: async () => {},
    });

    expect(captured?.mcpServers).toEqual(
      expect.objectContaining({ neko_records: expect.anything() }),
    );
    expect(captured?.mcpBridgeEnv).toMatchObject({
      OPENNEKO_MCP_ORG_ID: "org-1",
      OPENNEKO_MCP_RUN_ID: "run-1",
    });
  });

  it("does not mount customer data-source tools in records mode", async () => {
    let captured: AgentRunOptions | undefined;
    const backend: AgentBackend = {
      id: "hermes",
      capabilities: {
        mcpTools: true,
        sessionResume: false,
        nativeDelegation: "hermes-delegate-task",
      },
      async run(opts) {
        captured = opts;
        return { status: "completed", finalText: "done" };
      },
    };

    await runAgentBackend({
      backend,
      prompt: "prompt",
      userMessage: "most urgent activity",
      orgId: "org-1",
      threadId: "thread-1",
      runId: "run-1",
      workspace,
      controlPlane,
      pluginActions: [],
      sourceConfigEnabled: true,
      dataSurface: "records",
      backendState: {
        recordContext: {
          surface: "list",
          appId: "crm",
          appLabel: "CRM",
          objectApiName: "activity",
          objectLabel: "Activities",
        },
      },
      emit: async () => {},
    });

    expect(Object.keys(captured?.mcpServers ?? {})).toEqual(["neko_records"]);
    expect(captured?.mcpBridgeEnv?.OPENNEKO_MCP_RECORD_SCOPE).toBe(
      JSON.stringify({ appId: "crm", objectApiName: "activity" }),
    );
  });

  it("uses app ownership as context without narrowing the actor's records grants", async () => {
    let captured: AgentRunOptions | undefined;
    const backend: AgentBackend = {
      id: "hermes",
      capabilities: {
        mcpTools: true,
        sessionResume: false,
        nativeDelegation: "hermes-delegate-task",
      },
      async run(opts) {
        captured = opts;
        return { status: "completed", finalText: "done" };
      },
    };

    await runAgentBackend({
      backend,
      prompt: "prompt",
      userMessage: "include this account's support tickets",
      orgId: "org-1",
      threadId: "thread-1",
      runId: "run-1",
      workspace,
      controlPlane,
      pluginActions: [],
      dataSurface: "records",
      backendState: {
        appContext: { appId: "crm", appLabel: "CRM" },
        recordContext: {
          surface: "detail",
          appId: "crm",
          appLabel: "CRM",
          objectApiName: "account",
          objectLabel: "Account",
          recordId: "account-1",
        },
      },
      emit: async () => {},
    });

    expect(Object.keys(captured?.mcpServers ?? {})).toEqual(["neko_records"]);
    expect(captured?.mcpBridgeEnv?.OPENNEKO_MCP_RECORD_SCOPE).toBeUndefined();
  });
});
