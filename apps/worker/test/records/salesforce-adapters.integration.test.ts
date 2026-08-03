import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dbReachable, createTestOrg, deleteTestOrg, uniqueOrgId } from "@neko/db/test-helpers";
import { and, db, eq, processing_job, sql } from "@neko/db";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import { defaultSalesforceActionDependencies } from "../../src/records/salesforce-adapters.js";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[salesforce-adapters] skipping: Postgres unreachable.");
}

describeIfDb("Salesforce action persistence", () => {
  let orgId: string;

  beforeEach(async () => {
    orgId = uniqueOrgId("salesforce-export");
    await createTestOrg(orgId);
  });

  afterEach(async () => {
    await deleteTestOrg(orgId);
  });

  it("serializes concurrent action retries into one durable export job", async () => {
    const now = new Date("2026-08-02T12:00:00.000Z");
    const actionRequestId = "00000000-0000-4000-a000-000000000721";
    const request: ActionRequestRecord = {
      id: actionRequestId,
      orgId,
      actorUserId: "admin-1",
      actorRole: "admin",
      actorBackend: "codex",
      workflowRunId: null,
      triggeredByObservationId: null,
      policyId: null,
      scope: "external",
      kind: "records_salesforce_export_start",
      target: null,
      payload: {
        source_instance_id: "salesforce-production",
        app: "crm",
      },
      riskLevel: "high",
      status: "approved",
      summary: "Export Salesforce",
      intent: "Export Salesforce",
      minutesSaved: null,
      minutesSavedBasis: null,
      workRunId: null,
      requestedByRunId: null,
      approvedByUserId: "admin-1",
      approvedAt: now,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };

    const [first, second] = await Promise.all([
      defaultSalesforceActionDependencies.createExport(request),
      defaultSalesforceActionDependencies.createExport(request),
    ]);
    expect(first.id).toBe(second.id);

    const rows = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(processing_job)
      .where(
        and(
          eq(processing_job.org_id, orgId),
          eq(processing_job.kind, "records_salesforce_export"),
          sql`${processing_job.trigger_payload}->>'action_request_id' = ${actionRequestId}`,
        ),
      );
    expect(rows[0]?.count).toBe(1);
  });
});
