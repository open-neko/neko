import { describe, expect, it, vi } from "vitest";
import type { RecordsSalesforceExportPayload } from "@neko/db/jobs";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  buildSalesforceAppSchema,
  createSalesforceSchemaReview,
  SalesforceApiError,
  type RecordConnectorExportResult,
} from "@neko/records";
import {
  runRecordsSalesforceExport,
  type RecordsSalesforceExportDependencies,
} from "../../src/jobs/records-salesforce-export.js";

const ACTION_ID = "00000000-0000-4000-a000-000000000711";
const EXPORT_ID = "00000000-0000-4000-a000-000000000712";
const payload: RecordsSalesforceExportPayload = {
  processingJobId: EXPORT_ID,
  exportJobId: EXPORT_ID,
  actionRequestId: ACTION_ID,
  orgId: "org-a",
};

function schemaPlan() {
  return buildSalesforceAppSchema({
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
  });
}

function schemaReview() {
  return createSalesforceSchemaReview({
    sourceInstanceId: "salesforce-production",
    mode: "mirror",
    plan: schemaPlan(),
  });
}

function request(): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: ACTION_ID,
    orgId: "org-a",
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
      salesforce_schema_review: schemaReview(),
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

function job(status = "queued") {
  return {
    id: EXPORT_ID,
    orgId: "org-a",
    kind: "records_salesforce_export",
    status,
    trigger: "action_request",
    triggerPayload: { action_request_id: ACTION_ID },
  };
}

function exportResult(): RecordConnectorExportResult {
  return {
    directory: "/safe/org/imports/salesforce/export",
    manifest: {
      format: "openneko.records.artifact.v1",
      source: {
        kind: "salesforce",
        instanceId: "salesforce-production",
        mode: "mirror",
      },
      generatedAt: "2026-08-02T12:00:00.000Z",
      watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      objects: [
        {
          sourceApiName: "Account",
          objectApiName: "account" as never,
          dataPath: "data/account.csv",
          describePath: "describe/account.json",
          expectedRows: 7,
          sha256: "a".repeat(64),
          watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
        },
      ],
      manifestHash: "b".repeat(64),
    },
  };
}

function dependencies(
  overrides: Partial<RecordsSalesforceExportDependencies> = {},
): RecordsSalesforceExportDependencies {
  return {
    getRequest: vi.fn().mockResolvedValue(request()),
    getJob: vi.fn().mockResolvedValue(job()),
    updateJob: vi.fn().mockResolvedValue(true),
    connectorForAction: vi.fn().mockResolvedValue({
      schemaPlan: vi.fn().mockResolvedValue(schemaPlan()),
      export: vi.fn().mockResolvedValue(exportResult()),
    }),
    workspaceForOrg: vi.fn().mockResolvedValue({ orgRoot: "/safe/org" }),
    cancellationPollMs: 5,
    scheduleImport: vi
      .fn()
      .mockResolvedValue("00000000-0000-4000-a000-000000000713"),
    ...overrides,
  };
}

describe("Salesforce export job", () => {
  it("exports into the org workspace and persists only a relative artifact path", async () => {
    const exportArtifact = vi.fn().mockResolvedValue(exportResult());
    const deps = dependencies({
      connectorForAction: vi.fn().mockResolvedValue({
        schemaPlan: vi.fn().mockResolvedValue(schemaPlan()),
        export: exportArtifact,
      }),
      getJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(job("running")),
    });
    await runRecordsSalesforceExport(payload, deps);

    expect(deps.scheduleImport).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACTION_ID }),
      payload,
      `imports/salesforce/${EXPORT_ID}`,
    );
    expect(exportArtifact).toHaveBeenCalledWith({
      directory: `/safe/org/imports/salesforce/${EXPORT_ID}`,
      resume: true,
      signal: expect.any(AbortSignal),
    });
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({
        status: "succeeded",
        progress: { stage: "complete", objects: 1, rows: 7 },
        result: expect.objectContaining({
          artifact_path: `imports/salesforce/${EXPORT_ID}`,
          artifact_import_action_id: "00000000-0000-4000-a000-000000000713",
        }),
      }),
      ["running"],
    );
    expect(JSON.stringify(vi.mocked(deps.updateJob).mock.calls)).not.toContain(
      "salesforce-production-secret",
    );
  });

  it("replays terminal jobs without calling Salesforce", async () => {
    const deps = dependencies({ getJob: vi.fn().mockResolvedValue(job("succeeded")) });
    await runRecordsSalesforceExport(payload, deps);
    expect(deps.connectorForAction).not.toHaveBeenCalled();
    expect(deps.updateJob).not.toHaveBeenCalled();
  });

  it("honors cancellation before launch and after an export race", async () => {
    const before = dependencies({
      getJob: vi.fn().mockResolvedValue(job("cancel_requested")),
    });
    await runRecordsSalesforceExport(payload, before);
    expect(before.connectorForAction).not.toHaveBeenCalled();
    expect(before.updateJob).toHaveBeenCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({ status: "cancelled" }),
    );

    const after = dependencies({
      getJob: vi
        .fn()
        .mockResolvedValueOnce(job())
        .mockResolvedValue(job("cancel_requested")),
    });
    await runRecordsSalesforceExport(payload, after);
    expect(after.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("checkpoints retryable failures for a pg-boss resume", async () => {
    const failure = new SalesforceApiError("Salesforce busy", 503, true);
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(job("running")),
      connectorForAction: vi.fn().mockResolvedValue({
        schemaPlan: vi.fn().mockResolvedValue(schemaPlan()),
        export: vi.fn().mockRejectedValue(failure),
      }),
    });
    await expect(runRecordsSalesforceExport(payload, deps)).rejects.toBe(failure);
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({
        status: "retrying",
        progress: { stage: "retrying", resume: true },
      }),
    );
  });

  it("marks permanent failures terminal without asking pg-boss to retry", async () => {
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(job("running")),
      connectorForAction: vi.fn().mockRejectedValue(new Error("secret reference missing")),
    });
    await expect(runRecordsSalesforceExport(payload, deps)).resolves.toBeUndefined();
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({ status: "failed", error: "secret reference missing" }),
    );
  });

  it("fails closed before export when Salesforce schema drifted after approval", async () => {
    const exportArtifact = vi.fn();
    const drifted = buildSalesforceAppSchema({
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
            {
              name: "Unreviewed__c",
              label: "Unreviewed",
              type: "string",
              createable: true,
              updateable: true,
            },
          ],
        },
      ],
    });
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValueOnce(job()).mockResolvedValue(job("running")),
      connectorForAction: vi.fn().mockResolvedValue({
        schemaPlan: vi.fn().mockResolvedValue(drifted),
        export: exportArtifact,
      }),
    });
    await expect(runRecordsSalesforceExport(payload, deps)).resolves.toBeUndefined();
    expect(exportArtifact).not.toHaveBeenCalled();
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      EXPORT_ID,
      expect.objectContaining({
        status: "failed",
        error: "Salesforce schema changed after approval",
      }),
    );
  });

  it("rejects forged job-to-action relationships before connector construction", async () => {
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValue({
        ...job(),
        triggerPayload: { action_request_id: "00000000-0000-4000-a000-000000000799" },
      }),
    });
    await expect(runRecordsSalesforceExport(payload, deps)).rejects.toThrow(
      /does not belong/i,
    );
    expect(deps.connectorForAction).not.toHaveBeenCalled();
  });
});
