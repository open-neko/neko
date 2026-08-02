import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  action_request,
  and,
  db,
  eq,
} from "@neko/db";
import { stopBoss, type RecordsSalesforceExportPayload } from "@neko/db/jobs";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import {
  seedDefaultActionPolicies,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  buildSalesforceAppSchema,
  createSalesforceSchemaReview,
} from "@neko/records";
import { scheduleSalesforceArtifactImport } from "../../src/jobs/records-salesforce-export.js";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[salesforce-export-scheduler] skipping: Postgres unreachable.");
}

function exportRequest(orgId: string): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: "00000000-0000-4000-a000-000000000841",
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
      instance_url: "https://example.my.salesforce.com",
      client_id: "connected-app",
      client_secret_ref: "salesforce-production-secret",
      app: "crm",
      label: "CRM",
      mode: "mirror",
      objects: ["Account"],
      salesforce_inventory: {
        connector: "salesforce",
        sourceInstanceId: "salesforce-production",
        mode: "mirror",
        objects: [],
        warnings: [],
      },
      salesforce_schema_review: createSalesforceSchemaReview({
        sourceInstanceId: "salesforce-production",
        mode: "mirror",
        plan: buildSalesforceAppSchema({
          app: "crm",
          label: "CRM",
          mode: "mirror",
          describes: [
            {
              name: "Account",
              label: "Account",
              labelPlural: "Accounts",
              fields: [
                { name: "Id", label: "Account ID", type: "id" },
                {
                  name: "Name",
                  label: "Account name",
                  type: "string",
                  nameField: true,
                  createable: true,
                  updateable: true,
                },
              ],
            },
          ],
        }),
      }),
    },
    riskLevel: "high",
    status: "executed",
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
}

describeIfDb("Salesforce export-to-import chaining", () => {
  let orgId: string;

  beforeEach(async () => {
    orgId = uniqueOrgId("salesforce-chain");
    await createTestOrg(orgId);
    await seedDefaultActionPolicies(orgId);
  });

  afterEach(async () => {
    await stopBoss();
    await deleteTestOrg(orgId);
  });

  it("creates and queues one secret-free trusted action across retries", async () => {
    const jobId = "00000000-0000-4000-a000-000000000842";
    const payload: RecordsSalesforceExportPayload = {
      orgId,
      processingJobId: jobId,
      exportJobId: jobId,
      actionRequestId: "00000000-0000-4000-a000-000000000841",
    };
    const request = exportRequest(orgId);
    const first = await scheduleSalesforceArtifactImport(
      request,
      payload,
      `imports/salesforce/${jobId}`,
    );
    const second = await scheduleSalesforceArtifactImport(
      request,
      payload,
      `imports/salesforce/${jobId}`,
    );
    expect(second).toBe(first);

    const rows = await db()
      .select({
        id: action_request.id,
        status: action_request.status,
        backend: action_request.actor_backend,
        payload: action_request.payload,
      })
      .from(action_request)
      .where(
        and(
          eq(action_request.org_id, orgId),
          eq(action_request.kind, "records_artifact_import_from_export"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first,
      status: "approved",
      backend: "records-salesforce-export",
      payload: {
        artifact_path: `imports/salesforce/${jobId}`,
        app: "crm",
        label: "CRM",
        export_job_id: jobId,
        source_instance_id: "salesforce-production",
        approved_schema_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(rows[0]?.payload)).not.toContain("salesforce-production-secret");
  });
});
