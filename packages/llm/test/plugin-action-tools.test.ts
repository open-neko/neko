import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControlPlane } from "../src/work/control-plane";

const sdk = vi.hoisted(() => ({
  tools: new Map<
    string,
    {
      description: string;
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }
  >(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((input: unknown) => input),
  tool: vi.fn(
    (
      name: string,
      description: string,
      _schema: unknown,
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }> }>,
    ) => {
      sdk.tools.set(name, { description, handler });
      return { name };
    },
  ),
}));

import { buildPluginActionServer } from "../src/work/tools";

function controlPlane(
  result: Awaited<
    ReturnType<AgentControlPlane["waitForActionExecution"]>
  >,
): Pick<
  AgentControlPlane,
  | "evaluateActionPolicy"
  | "createActionRequest"
  | "enqueueActionExecute"
  | "waitForActionExecution"
> {
  return {
    async evaluateActionPolicy() {
      return {
        decision: "allow",
        mode: "auto",
        reason: "test",
        policy: { id: "policy-1", name: "Read-only web" },
      } as Awaited<
        ReturnType<AgentControlPlane["evaluateActionPolicy"]>
      >;
    },
    async createActionRequest() {
      return { id: "action-1" };
    },
    async enqueueActionExecute() {},
    async waitForActionExecution() {
      return result;
    },
  };
}

async function invoke(
  result: Awaited<
    ReturnType<AgentControlPlane["waitForActionExecution"]>
  >,
) {
  const emit = vi.fn();
  buildPluginActionServer({
    orgId: "org-1",
    threadId: "thread-1",
    runId: "run-1",
    descriptors: [
      {
        kind: "web_search",
        description: "Search the live web.",
        default_mode: "auto",
      },
    ],
    emit,
    controlPlane: controlPlane(result) as AgentControlPlane,
  });
  const registered = sdk.tools.get("web_search");
  if (!registered) throw new Error("web_search tool was not registered");
  const response = await registered.handler({
    payload: { query: "Igatpuri weather" },
  });
  return {
    description: registered.description,
    emit,
    body: JSON.parse(response.content[0]?.text ?? "{}") as Record<
      string,
      unknown
    >,
  };
}

describe("auto-mode plugin action tools", () => {
  beforeEach(() => sdk.tools.clear());

  it("waits for execution and returns the real outcome to the agent", async () => {
    const result = await invoke({
      status: "succeeded",
      outcome: { result: { text: "Rain through Tuesday." } },
    });

    expect(result.body).toMatchObject({
      ok: true,
      status: "executed",
      outcome: { result: { text: "Rain through Tuesday." } },
    });
    expect(result.description).toContain("use its returned outcome");
    expect(result.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "action_request_emit",
        decision: "auto_approved",
      }),
    );
  });

  it("returns execution failures instead of claiming the action is queued", async () => {
    const result = await invoke({
      status: "failed",
      error: "upstream schema rejected the request",
    });

    expect(result.body).toMatchObject({
      ok: false,
      status: "failed",
      error: "upstream schema rejected the request",
    });
    expect(String(result.body.note)).toContain("Do not claim");
  });

  it("labels only genuine timeouts as still running", async () => {
    const result = await invoke({ status: "timeout" });

    expect(result.body).toMatchObject({
      ok: true,
      status: "running",
    });
    expect(String(result.body.note)).toContain("taking longer");
  });
});
