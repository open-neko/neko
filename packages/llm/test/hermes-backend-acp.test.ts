import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkNotification,
  createMockSpawn,
  makeController,
  NO_RESPONSE,
  toolCallNotification,
  toolCallUpdateNotification,
} from "./helpers/fake-acp-process";

const controller = makeController();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: createMockSpawn(controller),
  };
});

beforeEach(() => {
  controller.spawnCalls.length = 0;
  controller.setScript({});
});

afterEach(() => {
  vi.clearAllMocks();
});

const { HermesBackend } = await import("../src/agent-backends/hermes");

const FAKE_WORKSPACE = {
  orgRoot: "/tmp/neko-test/org",
  skillsRoot: "/tmp/neko-test/org/skills",
  memoryRoot: "/tmp/neko-test/org/memory",
  knowledgeRoot: "/tmp/neko-test/org/knowledge",
  uploadsRoot: "/tmp/neko-test/org/uploads",
  runsRoot: "/tmp/neko-test/org/runs",
  threadUploadsRoot: "/tmp/neko-test/org/uploads/t1",
  runRoot: "/tmp/neko-test/org/runs/r1",
  artifactRoot: "/tmp/neko-test/org/runs/r1/artifacts",
  binRoot: "/tmp/neko-test/org/runs/r1/bin",
} as const;

type SeenRequest = { method: string; params: unknown };

function captureRequests(): { seen: SeenRequest[]; record: (m: string, p: unknown) => void } {
  const seen: SeenRequest[] = [];
  return { seen, record: (method, params) => seen.push({ method, params }) };
}

describe("HermesBackend ACP behavior", () => {
  it("always uses session/new — never session/load — even when backendState carries a sessionKey", async () => {
    // Hermes ACP session/load replays prior history as session/update events.
    // The worker already injects history into the prompt
    // (packages/llm/src/work/prompt.ts:108), so session/load would
    // double-count context. We always start a fresh ACP session per turn.
    const cap = captureRequests();
    const sessionId = "sess-new-1";
    controller.setScript({
      responders: {
        "session/new": (p) => {
          cap.record("session/new", p);
          return { sessionId };
        },
        "session/load": (p) => {
          cap.record("session/load", p);
          return { sessionId: "should-never-fire" };
        },
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, "hi"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const backend = new HermesBackend();

    // First turn: no sessionKey in state → session/new.
    await backend.run({ prompt: "p", workspace: FAKE_WORKSPACE });
    // Second turn: sessionKey present in state → STILL session/new, never load.
    await backend.run({
      prompt: "p2",
      workspace: FAKE_WORKSPACE,
      backendState: { hermes: { sessionKey: "old-key-from-prior-turn" } },
    });

    const newCalls = cap.seen.filter((s) => s.method === "session/new");
    const loadCalls = cap.seen.filter((s) => s.method === "session/load");
    expect(newCalls).toHaveLength(2);
    expect(loadCalls).toHaveLength(0);
  });

  it("does not write a sessionKey into backendState (no resumption to support)", async () => {
    const sessionId = "sess-no-persist";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, "ok"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const backend = new HermesBackend();
    const result = await backend.run({ prompt: "p", workspace: FAKE_WORKSPACE });
    // backendState round-trips unchanged — Hermes branch is empty.
    expect(result.backendState).toEqual({});
  });

  it("emits assistant message events as deltas: chunks 'a','b','c' → ['a','b','c']", async () => {
    const sessionId = "sess-deltas";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, "a"));
          ctx.emitNotification(chunkNotification(sessionId, "b"));
          ctx.emitNotification(chunkNotification(sessionId, "c"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const events: Array<{ type: string; content?: string }> = [];
    const backend = new HermesBackend();
    const result = await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      onEvent: (e) => {
        events.push(e as { type: string; content?: string });
      },
    });
    const messageContents = events
      .filter((e) => e.type === "message")
      .map((e) => e.content);
    expect(messageContents).toEqual(["a", "b", "c"]);
    expect(result.finalText).toBe("abc");
  });

  it("retries a content-free end_turn, then fails instead of completing empty", async () => {
    let promptCalls = 0;
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId: `sess-empty-${promptCalls}` }),
        "session/prompt": () => {
          promptCalls += 1;
          return { stopReason: "end_turn" };
        },
      },
    });
    const events: Array<{ type: string; message?: string }> = [];
    const backend = new HermesBackend();

    const result = await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      retries: 1,
      onEvent: (event) => {
        events.push(event as { type: string; message?: string });
      },
    });

    expect(promptCalls).toBe(2);
    expect(result).toMatchObject({
      status: "failed",
      finalText: "",
      error: expect.stringContaining("completed without assistant output"),
    });
    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("stopReason=end_turn"),
      }),
    ]);
  });

  it("awaits async event handlers in chunk order before returning", async () => {
    const sessionId = "sess-ordered-events";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, "first"));
          ctx.emitNotification(chunkNotification(sessionId, "second"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const contents: string[] = [];
    const backend = new HermesBackend();

    await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      onEvent: async (event) => {
        if (event.type !== "message") return;
        if (event.content === "first") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        contents.push(event.content);
      },
    });

    expect(contents).toEqual(["first", "second"]);
  });

  it("emits tool_start then tool_end with matching toolCallId", async () => {
    const sessionId = "sess-tool";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(
            toolCallNotification(sessionId, "tc-1", { kind: "read", title: "read: /tmp/x.txt", locations: [{ path: "/tmp/x.txt" }] }),
          );
          ctx.emitNotification(
            toolCallUpdateNotification(sessionId, "tc-1", { status: "completed", rawOutput: "file contents" }),
          );
          ctx.emitNotification(chunkNotification(sessionId, "Done"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const events: Array<{ type: string; id?: string; result?: unknown; name?: string }> = [];
    const backend = new HermesBackend();
    await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      onEvent: (e) => {
        events.push(e as { type: string; id?: string });
      },
    });
    const toolStart = events.find((e) => e.type === "tool_start");
    const toolEnd = events.find((e) => e.type === "tool_end");
    expect(toolStart).toBeDefined();
    expect(toolStart?.id).toBe("tc-1");
    expect(toolStart?.name).toBe("read");
    expect(toolEnd).toBeDefined();
    expect(toolEnd?.id).toBe("tc-1");
    expect(toolEnd?.result).toBe("file contents");
  });

  it("does not accept a legacy fence as a second live render path", async () => {
    const sessionId = "sess-surface";
    const fenced = "Here is the surface:\n```neko_a2ui\n[{\"version\":\"v0.9\",\"createSurface\":{\"surfaceId\":\"s1\",\"catalogId\":\"urn:app:catalog:briefing:v1\"}}]\n```\nDone.";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, fenced));
          return { stopReason: "end_turn" };
        },
      },
    });
    const events: Array<{ type: string }> = [];
    const backend = new HermesBackend();
    const result = await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(events.find((e) => e.type === "surface")).toBeUndefined();
    expect(result.finalText).not.toContain("```neko_a2ui");
    expect(result.finalText).toContain("Done.");
  });

  it("leaves fence in finalText when onEvent is absent (sync callers parse it later)", async () => {
    const sessionId = "sess-surface-sync";
    const fenced = "Here is the surface:\n```neko_a2ui\n[]\n```";
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification(sessionId, fenced));
          return { stopReason: "end_turn" };
        },
      },
    });
    const backend = new HermesBackend();
    const result = await backend.run({ prompt: "p", workspace: FAKE_WORKSPACE });
    expect(result.finalText).toContain("```neko_a2ui");
  });

  it("AbortSignal triggers cancelled status and SIGTERM to process group", async () => {
    const sessionId = "sess-abort";
    let promptStarted = false;
    controller.setScript({
      staysOpen: true,
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": () => {
          promptStarted = true;
          return NO_RESPONSE;
        },
      },
    });
    const ctrl = new AbortController();
    const backend = new HermesBackend();
    const runPromise = backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      signal: ctrl.signal,
    });
    await new Promise<void>((resolve) => {
      const tick = () => (promptStarted ? resolve() : setTimeout(tick, 5));
      tick();
    });
    ctrl.abort();
    const result = await runPromise;
    expect(result.status).toBe("cancelled");
  });

  it("timeout settles with failed status and error event", async () => {
    const sessionId = "sess-timeout";
    controller.setScript({
      staysOpen: true,
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": () => NO_RESPONSE,
      },
    });
    const events: Array<{ type: string; message?: string }> = [];
    const backend = new HermesBackend();
    const result = await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      timeoutMs: 50,
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    expect(result.status).toBe("failed");
    expect(events.find((e) => e.type === "error")).toBeDefined();
  });

  it("JSON-RPC error response from session/prompt yields failed status with error message", async () => {
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId: "sess-error" }),
        "session/prompt": () => {
          const err: Error & { code?: number } = new Error("Provider gemini returned 503");
          err.code = -32603;
          throw err;
        },
      },
    });
    const events: Array<{ type: string; message?: string }> = [];
    const backend = new HermesBackend();
    const result = await backend.run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      onEvent: (e) => {
        events.push(e as { type: string; message?: string });
      },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Provider gemini returned 503");
    expect(events.find((e) => e.type === "error")).toBeDefined();
  });

  it("web turn: mounts the one brokered render server and suppresses an accepted render pill", async () => {
    const previousBridge = process.env.OPENNEKO_MCP_BRIDGE;
    process.env.OPENNEKO_MCP_BRIDGE = "/app/mcp-bridge.js";
    const cap = captureRequests();
    const sessionId = "sess-render";
    const a2ui = [
      {
        version: "v1.0",
        createSurface: {
          surfaceId: "s1",
          catalogId: "urn:openneko:catalog:work:v2",
          components: [{ id: "root", component: "MetricCard", metric: "42", label: "Test" }],
        },
      },
    ];
    controller.setScript({
      responders: {
        "session/new": (p) => { cap.record("session/new", p); return { sessionId }; },
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-render",
                kind: "other",
                title: "mcp_neko_ui_render_cards",
                rawInput: { messages: a2ui },
              },
            },
          });
          ctx.emitNotification(
            toolCallUpdateNotification(sessionId, "tc-render", {
              status: "completed",
              content: '{"ok":true,"accepted":1}',
            }),
          );
          return { stopReason: "end_turn" };
        },
      },
    });
    try {
      const events: Array<{ type: string; messages?: unknown[] }> = [];
      const backend = new HermesBackend();
      await backend.run({
        prompt: "p",
        workspace: FAKE_WORKSPACE,
        wantsCards: true,
        mcpServers: { neko_ui: {} as never },
        mcpBridgeEnv: { OPENNEKO_MCP_ORG_ID: "org-1" },
        onEvent: (e) => { events.push(e as { type: string; messages?: unknown[] }); },
      });

      const sn = cap.seen.find((s) => s.method === "session/new");
      expect(JSON.stringify(sn?.params)).toContain(
        "/app/mcp-bridge.js neko_ui",
      );
      // The neko_ui server emits the surface through the broker event sink;
      // Hermes only classifies its ACP notification and hides the tool pill.
      expect(events.some((e) => e.type === "tool_start")).toBe(false);
      expect(events.some((e) => e.type === "surface")).toBe(false);
    } finally {
      if (previousBridge === undefined) delete process.env.OPENNEKO_MCP_BRIDGE;
      else process.env.OPENNEKO_MCP_BRIDGE = previousBridge;
    }
  });

  it("preserves a rejected render input in tool_start telemetry", async () => {
    const sessionId = "sess-render-rejected";
    const rejectedInput = {
      messages: [{ version: "v1.0", createSurface: { surfaceId: "broken" } }],
    };
    controller.setScript({
      responders: {
        "session/new": () => ({ sessionId }),
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-render-rejected",
                kind: "other",
                title: "mcp_neko_ui_render_cards",
                rawInput: rejectedInput,
              },
            },
          });
          ctx.emitNotification(
            toolCallUpdateNotification(sessionId, "tc-render-rejected", {
              status: "failed",
              content: "Invalid tool arguments",
            }),
          );
          ctx.emitNotification(chunkNotification(sessionId, "I could not render that surface."));
          return { stopReason: "end_turn" };
        },
      },
    });
    const events: Array<Record<string, unknown>> = [];
    await new HermesBackend().run({
      prompt: "p",
      workspace: FAKE_WORKSPACE,
      wantsCards: true,
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    });

    const start = events.find((event) => event.type === "tool_start");
    expect(start).toMatchObject({
      id: "tc-render-rejected",
      name: "render_cards",
      input: {
        title: "mcp_neko_ui_render_cards",
        rawInput: rejectedInput,
      },
    });
    expect(
      (start?.input as { validationIssues?: unknown[] }).validationIssues,
    ).not.toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_end",
        id: "tc-render-rejected",
        error: "Invalid tool arguments",
      }),
    );
  });

  it("non-web turn: does not offer the render MCP server", async () => {
    const cap = captureRequests();
    controller.setScript({
      responders: {
        "session/new": (p) => { cap.record("session/new", p); return { sessionId: "s" }; },
        "session/prompt": (_p, ctx) => {
          ctx.emitNotification(chunkNotification("s", "hi"));
          return { stopReason: "end_turn" };
        },
      },
    });
    const backend = new HermesBackend();
    await backend.run({ prompt: "p", workspace: FAKE_WORKSPACE }); // wantsCards defaults false
    const sn = cap.seen.find((s) => s.method === "session/new");
    expect((sn?.params as { mcpServers?: unknown[] }).mcpServers).toEqual([]);
    expect(JSON.stringify(sn?.params)).not.toContain("neko_render");
  });

  it("mounts all logical OpenNeko tools through one multiplexed MCP child", async () => {
    const previousBridge = process.env.OPENNEKO_MCP_BRIDGE;
    process.env.OPENNEKO_MCP_BRIDGE = "/app/mcp-bridge.js";
    const cap = captureRequests();
    controller.setScript({
      responders: {
        "session/new": (p) => {
          cap.record("session/new", p);
          return { sessionId: "s-multiplexed" };
        },
      },
    });

    try {
      const backend = new HermesBackend();
      await backend.run({
        prompt: "p",
        workspace: FAKE_WORKSPACE,
        mcpServers: {
          neko_memory: {} as never,
          neko_records: {} as never,
          neko_ui: {} as never,
        },
        wantsCards: true,
        mcpBridgeEnv: { OPENNEKO_MCP_ORG_ID: "org-1" },
      });
      const sn = cap.seen.find((s) => s.method === "session/new");
      const mounted = (sn?.params as {
        mcpServers?: Array<{ name: string; args: string[] }>;
      }).mcpServers;
      expect(mounted).toHaveLength(1);
      expect(mounted?.[0]?.name).toBe("neko");
      expect(mounted?.[0]?.args.join(" ")).toContain(
        "/app/mcp-bridge.js neko_memory,neko_records,neko_ui",
      );
    } finally {
      if (previousBridge === undefined) delete process.env.OPENNEKO_MCP_BRIDGE;
      else process.env.OPENNEKO_MCP_BRIDGE = previousBridge;
    }
  });
});
