import { describe, expect, it } from "vitest";
import {
  groupAwaiting,
  type AwaitingRow,
} from "@/lib/dashboard-actions";

function awaitingRow(overrides: Partial<AwaitingRow> = {}): AwaitingRow {
  return {
    id: "action-1",
    workflowRunId: "run-1",
    workflow: { id: "workflow-1", name: "Renewal monitor" },
    triggeredByObservation: null,
    kind: "email_send",
    target: "ops@example.com",
    riskLevel: "medium",
    summary: "Send a renewal reminder",
    status: "pending_approval",
    runAt: "2026-08-17T10:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

describe("groupAwaiting", () => {
  it("renders a run-less approval as its own OpenNeko AI card", () => {
    const [group] = groupAwaiting([
      awaitingRow({
        workflowRunId: null,
        workflow: null,
        summary: null,
        kind: "app_create",
      }),
    ]);

    expect(group).toMatchObject({
      key: "action:action-1",
      card: {
        runId: null,
        workflowName: "OpenNeko AI",
        state: "awaiting",
        rows: [{ id: "action-1", headline: "app_create" }],
      },
    });
  });

  it("does not collapse separate run-less approvals into one card", () => {
    const groups = groupAwaiting([
      awaitingRow({ id: "action-1", workflowRunId: null, workflow: null }),
      awaitingRow({ id: "action-2", workflowRunId: null, workflow: null }),
    ]);

    expect(groups.map((group) => group.key)).toEqual([
      "action:action-1",
      "action:action-2",
    ]);
    expect(groups.every((group) => group.card.rows.length === 1)).toBe(true);
  });

  it("still groups approvals produced by the same workflow run", () => {
    const groups = groupAwaiting([
      awaitingRow({ id: "action-1" }),
      awaitingRow({ id: "action-2" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "run:run-1",
      card: {
        runId: "run-1",
        workflowName: "Renewal monitor",
        rows: [{ id: "action-1" }, { id: "action-2" }],
      },
    });
  });
});
