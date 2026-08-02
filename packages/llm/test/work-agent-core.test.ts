import { describe, expect, it } from "vitest";
import type {
  AgentBackend,
  AgentRunOptions,
  AgentWorkspace,
} from "../src/agent-backend";
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
  claudeProjectRoot: "/tmp/org",
  claudeConfigRoot: "/tmp/org/claude/config",
};

describe("runAgentBackend", () => {
  it("mounts actor-scoped native records tools for MCP-capable chat agents", async () => {
    let captured: AgentRunOptions | undefined;
    const backend: AgentBackend = {
      id: "hermes",
      capabilities: {
        mcpTools: true,
        sdkStopHook: false,
        sessionResume: false,
        canUseToolGate: true,
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
});
