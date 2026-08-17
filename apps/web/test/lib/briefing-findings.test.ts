import { describe, expect, it } from "vitest";
import { serializeBriefingApproval } from "@/lib/briefing-findings";
import { workflowDisplayName } from "@/lib/workflow-label";

describe("briefing approval serialization", () => {
  it("preserves a run-less approval without inventing a workflow", () => {
    const approval = serializeBriefingApproval({
      id: "action-1",
      workflowRunId: null,
      workflowId: null,
      workflowName: null,
      kind: "app_create",
      target: null,
      summary: null,
      riskLevel: "medium",
      createdAt: new Date("2026-08-17T10:00:00.000Z"),
    });

    expect(approval).toMatchObject({
      id: "action-1",
      kind: "approval",
      workflowRunId: null,
      workflow: null,
      title: "app_create",
    });
    expect(workflowDisplayName(approval.workflow)).toBe("OpenNeko AI");
  });
});
