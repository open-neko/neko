import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { and, app_state, db, eq } from "@neko/db";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import { recordIdentifier, type RecordArtifactImportPlan } from "@neko/records";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import { projectMetadataAppState } from "../../src/records/schema-runtime.js";
import {
  refreshArtifactImportState,
  stageArtifactImportState,
  trackArtifactImportRuns,
} from "../../src/records/artifact-import-state.js";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[artifact-import-state] skipping: Postgres unreachable.");
}

function request(orgId: string): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: "00000000-0000-4000-a000-000000000831",
    orgId,
    actorUserId: "admin-1",
    actorRole: "admin",
    actorBackend: "records-salesforce-export",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind: "records_artifact_import_from_export",
    target: "salesforce-export:job",
    payload: {
      export_action_request_id: "00000000-0000-4000-a000-000000000830",
    },
    riskLevel: "high",
    status: "approved",
    summary: "Import CRM",
    intent: "Import CRM",
    minutesSaved: null,
    minutesSavedBasis: null,
    workRunId: null,
    requestedByRunId: null,
    approvedByUserId: null,
    approvedAt: now,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function plan(): RecordArtifactImportPlan {
  const appId = recordIdentifier("crm");
  return {
    format: "openneko.records.artifact-import.v1",
    directory: "imports/salesforce/job",
    manifest: {
      format: "openneko.records.artifact.v1",
      source: {
        kind: "salesforce",
        instanceId: "salesforce-production",
        mode: "mirror",
      },
      generatedAt: "2026-08-02T12:00:00.000Z",
      watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      objects: [],
      manifestHash: "a".repeat(64),
    },
    definition: {
      appId,
      label: "CRM",
      purpose: "Salesforce mirror",
      navOrder: 0,
      archived: false,
      objects: [],
      permissions: [],
      pages: [],
    },
    sourceSchemaHash: "c".repeat(64),
    imports: [],
    warnings: [],
    planHash: "b".repeat(64),
  };
}

describeIfDb("artifact import metadata lifecycle", () => {
  let orgId: string;

  beforeEach(async () => {
    orgId = uniqueOrgId("artifact-state");
    await createTestOrg(orgId);
  });

  afterEach(async () => {
    await deleteTestOrg(orgId);
  });

  it("keeps the app hidden through schema projection and activates only after all runs reconcile", async () => {
    const action = request(orgId);
    const artifactPlan = plan();
    const runIds = [
      "00000000-0000-4000-a000-000000000832",
      "00000000-0000-4000-a000-000000000833",
    ];
    await stageArtifactImportState(action, artifactPlan);
    await projectMetadataAppState({
      orgId,
      definition: artifactPlan.definition,
      registryRevision: "1",
      actorUserId: "admin-1",
    });
    let rows = await db()
      .select({ status: app_state.status, config: app_state.config })
      .from(app_state)
      .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, "crm")));
    expect(rows[0]).toMatchObject({
      status: "importing",
      config: { mode: "mirror", import: { status: "schema" } },
    });

    await trackArtifactImportRuns(action, artifactPlan, runIds);
    const recordsPool = {
      query: async () => ({
        rowCount: 2,
        rows: runIds.map((id) => ({
          id,
          status: "succeeded",
          report: { inserted: 1, reconciled: true },
          error: null,
        })),
      }),
    } as unknown as Pool;
    const onReportReady = vi.fn(async () => undefined);
    const validate = vi.fn(async () => ({
      format: "openneko.records.artifact-import-validation.v1" as const,
      integrity: "passed" as const,
      rows: [],
      sampledChecksums: [],
      danglingReferences: [],
      unmatchedUsers: null,
      permissionCollapse: {
        strategy: "admin_member" as const,
        source: "salesforce_v1_mode_defaults" as const,
        roles: [],
        note: "test",
      },
      recordCountsRefreshed: true,
    }));
    await expect(
      refreshArtifactImportState(recordsPool, {
        orgId,
        importRunId: runIds[0]!,
        graphjin: { execute: vi.fn() },
        serviceToken: "service-token",
        validate,
        onReportReady,
      }),
    ).resolves.toEqual({ matched: true, status: "succeeded" });
    expect(onReportReady).toHaveBeenCalledWith({
      orgId,
      report: expect.objectContaining({
        appId: "crm",
        status: "succeeded",
        runIds,
        progress: expect.objectContaining({ total: 2, succeeded: 2, missing: 0 }),
        reports: {
          [runIds[0]!]: { inserted: 1, reconciled: true },
          [runIds[1]!]: { inserted: 1, reconciled: true },
        },
        validation: expect.objectContaining({ integrity: "passed" }),
      }),
    });
    rows = await db()
      .select({ status: app_state.status, config: app_state.config })
      .from(app_state)
      .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, "crm")));
    expect(rows[0]).toMatchObject({
      status: "active",
      config: {
        mode: "mirror",
        import: {
          status: "succeeded",
          progress: { total: 2, succeeded: 2, missing: 0 },
        },
      },
    });
  });

  it("keeps the app degraded when aggregate integrity validation fails", async () => {
    const action = request(orgId);
    const artifactPlan = plan();
    const runId = "00000000-0000-4000-a000-000000000834";
    await stageArtifactImportState(action, artifactPlan);
    await projectMetadataAppState({
      orgId,
      definition: artifactPlan.definition,
      registryRevision: "1",
      actorUserId: "admin-1",
    });
    await trackArtifactImportRuns(action, artifactPlan, [runId]);
    const recordsPool = {
      query: async () => ({
        rowCount: 1,
        rows: [
          {
            id: runId,
            status: "succeeded",
            report: { inserted: 1, reconciled: true },
            error: null,
          },
        ],
      }),
    } as unknown as Pool;
    const validate = vi.fn(async () => ({
      format: "openneko.records.artifact-import-validation.v1" as const,
      integrity: "failed" as const,
      rows: [{
        objectApiName: "account",
        expected: 1,
        inserted: 1,
        rejected: 0,
        duplicates: 0,
        live: 0,
        reconciled: false,
      }],
      sampledChecksums: [],
      danglingReferences: [],
      unmatchedUsers: null,
      permissionCollapse: {
        strategy: "admin_member" as const,
        source: "salesforce_v1_mode_defaults" as const,
        roles: [],
        note: "test",
      },
      recordCountsRefreshed: true,
    }));
    const onReportReady = vi.fn(async () => undefined);

    await expect(
      refreshArtifactImportState(recordsPool, {
        orgId,
        importRunId: runId,
        graphjin: { execute: vi.fn() },
        serviceToken: "service-token",
        validate,
        onReportReady,
      }),
    ).resolves.toEqual({ matched: true, status: "failed" });
    const rows = await db()
      .select({ status: app_state.status, config: app_state.config })
      .from(app_state)
      .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, "crm")));
    expect(rows[0]).toMatchObject({
      status: "degraded",
      config: {
        import: {
          status: "failed",
          error: "post-import row or checksum validation failed",
          validation: { integrity: "failed" },
        },
      },
    });
    expect(onReportReady).toHaveBeenCalledWith({
      orgId,
      report: expect.objectContaining({
        status: "failed",
        validation: expect.objectContaining({ integrity: "failed" }),
      }),
    });
  });
});
