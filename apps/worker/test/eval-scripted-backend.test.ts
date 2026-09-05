import { describe, expect, it, vi } from "vitest";
import { buildRenderCardsServer } from "@neko/llm/work";
import type { AgentEvent, AgentWorkspace } from "@neko/llm";
import { ScriptedEvalBackend } from "../scripts/eval-scripted-backend";

const WORKSPACE: AgentWorkspace = {
  orgRoot: "/tmp/openneko-scripted-eval",
  skillsRoot: "/tmp/openneko-scripted-eval/skills",
  memoryRoot: "/tmp/openneko-scripted-eval/memory",
  knowledgeRoot: "/tmp/openneko-scripted-eval/knowledge",
  uploadsRoot: "/tmp/openneko-scripted-eval/uploads",
  runsRoot: "/tmp/openneko-scripted-eval/runs",
  threadUploadsRoot: "/tmp/openneko-scripted-eval/uploads/thread",
  runRoot: "/tmp/openneko-scripted-eval/runs/run",
  artifactRoot: "/tmp/openneko-scripted-eval/runs/run/artifacts",
  binRoot: "/tmp/openneko-scripted-eval/runs/run/bin",
};

describe("scripted eval backend", () => {
  it("calls a real OpenNeko MCP server and emits balanced tool evidence", async () => {
    const rendered = vi.fn(async () => {});
    const events: AgentEvent[] = [];
    const backend = new ScriptedEvalBackend("scripted-good", async (context) => {
      expect(await context.listTools("neko_ui")).toEqual(["render_cards"]);
      const result = await context.call("neko_ui", "render_cards", {
        messages: [
          {
            version: "v1.0",
            createSurface: {
              surfaceId: "scripted-eval",
              catalogId: "urn:openneko:catalog:work:v2",
              components: [{ id: "root", component: "Answer" }],
            },
          },
        ],
      });
      expect(result.isError).toBe(false);
      return "SCRIPTED_OK";
    });

    const result = await backend.run({
      prompt: "fixed eval prompt",
      userMessage: "render",
      workspace: WORKSPACE,
      mcpServers: { neko_ui: buildRenderCardsServer(rendered) },
      onEvent: async (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({ status: "completed", finalText: "SCRIPTED_OK" });
    expect(rendered).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual([
      "tool_start",
      "tool_end",
      "message",
      "usage",
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_start",
      id: "scripted-tool-1",
      name: "mcp_neko_ui_render_cards",
    });
    expect(events[1]).toMatchObject({ type: "tool_end", id: "scripted-tool-1" });
  });
});
