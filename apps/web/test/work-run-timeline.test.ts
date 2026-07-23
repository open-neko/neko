import { describe, expect, it } from "vitest";
import {
  buildRunTimeline,
  type WorkEvent,
} from "../src/app/(work)/work/work-screen";

function toolItems(events: WorkEvent[]) {
  return buildRunTimeline(events, "run-1").items.filter(
    (item) => item.kind === "tools",
  );
}

describe("work run action timeline", () => {
  it("keeps auto-approved actions as a single ordinary tool row", () => {
    const items = toolItems([
      { type: "tool_start", id: "tool-1", name: "web_search" },
      {
        type: "action_request_emit",
        action_request_id: "action-1",
        kind: "web_search",
        scope: "external",
        summary: "Search for the Igatpuri forecast",
        decision: "auto_approved",
      },
      {
        type: "action_request_result",
        action_request_id: "action-1",
        kind: "web_search",
        status: "succeeded",
      },
      { type: "tool_end", id: "tool-1", result: { ok: true } },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("tools");
    if (items[0]?.kind !== "tools") throw new Error("Expected tool row");
    expect(items[0].tools).toHaveLength(1);
    expect(items[0].tools[0]?.approval).toBeUndefined();
  });

  it("attaches a pending approval to the originating tool row", () => {
    const items = toolItems([
      {
        type: "tool_start",
        id: "tool-1",
        name: "request_plugin_install",
      },
      {
        type: "action_request_emit",
        action_request_id: "action-1",
        kind: "plugin_install",
        scope: "external",
        intent: "Install the weather integration",
        decision: "pending_approval",
      },
      { type: "tool_end", id: "tool-1", result: { ok: true } },
      {
        type: "action_request_result",
        action_request_id: "action-1",
        kind: "plugin_install",
        status: "succeeded",
      },
    ]);

    expect(items).toHaveLength(1);
    if (items[0]?.kind !== "tools") throw new Error("Expected tool row");
    expect(items[0].tools).toHaveLength(1);
    expect(items[0].tools[0]?.approval).toMatchObject({
      actionRequestId: "action-1",
      actionKind: "plugin_install",
      intent: "Install the weather integration",
      result: { status: "succeeded" },
    });
  });

  it("uses the same tool row shape for historical approvals without tool events", () => {
    const items = toolItems([
      {
        type: "action_request_emit",
        action_request_id: "action-legacy",
        kind: "plugin_uninstall",
        scope: "external",
        summary: "Remove the unused integration",
        decision: "pending_approval",
      },
    ]);

    expect(items).toHaveLength(1);
    if (items[0]?.kind !== "tools") throw new Error("Expected tool row");
    expect(items[0].tools[0]).toMatchObject({
      id: "approval-action-legacy",
      name: "plugin_uninstall",
      approval: {
        actionRequestId: "action-legacy",
        actionKind: "plugin_uninstall",
      },
    });
  });
});
