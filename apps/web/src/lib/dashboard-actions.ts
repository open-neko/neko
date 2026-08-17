import type { ActCardData, ActRowData } from "@/components/ActCard";
import { workflowDisplayName } from "@/lib/workflow-label";

export type AwaitingRow = {
  id: string;
  workflowRunId: string | null;
  workflow: { id: string; name: string } | null;
  triggeredByObservation: { title: string } | null;
  kind: string;
  target: string | null;
  riskLevel: string | null;
  summary: string | null;
  status: string;
  runAt: string;
  payload: unknown;
};

export type AwaitingPayload = {
  actions: AwaitingRow[];
  count: number;
};

/**
 * Group workflow-backed approvals by run. Chat-proposed approvals have no
 * workflow run, so each one gets its own card instead of sharing a null key.
 */
export function groupAwaiting(
  rows: AwaitingRow[],
): Array<{ key: string; card: ActCardData }> {
  const groups = new Map<
    string,
    {
      key: string;
      runId: string | null;
      runAt: string;
      trigger: string | null;
      workflowName: string;
      rows: ActRowData[];
    }
  >();

  for (const r of rows) {
    const tone: ActRowData["tone"] =
      r.riskLevel === "high" || r.riskLevel === "critical" ? "action" : "watch";
    const row: ActRowData = {
      id: r.id,
      tone,
      headline: r.summary || r.kind,
      detail: null,
      target: r.target,
      kind: r.kind,
      payload: r.payload,
      status: r.status,
    };
    const key = r.workflowRunId ? `run:${r.workflowRunId}` : `action:${r.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(key, {
        key,
        runId: r.workflowRunId,
        runAt: r.runAt,
        trigger: r.triggeredByObservation?.title ?? null,
        workflowName: workflowDisplayName(r.workflow),
        rows: [row],
      });
    }
  }

  return Array.from(groups.values()).map((g) => ({
    key: g.key,
    card: {
      runId: g.runId,
      runAt: g.runAt,
      trigger: g.trigger,
      state: "awaiting",
      workflowName: g.workflowName,
      rows: g.rows,
    },
  }));
}
