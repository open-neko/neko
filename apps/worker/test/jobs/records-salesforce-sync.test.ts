import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { RecordsSalesforceSyncPayload } from "@neko/db/jobs";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  buildSalesforceAppSchema,
  createSalesforceSchemaReview,
  SalesforceApiError,
  type RecordWriteExecutor,
} from "@neko/records";
import {
  runRecordsSalesforceSync,
  type RecordsSalesforceSyncDependencies,
} from "../../src/jobs/records-salesforce-sync.js";

const ACTION_ID = "00000000-0000-4000-a000-000000000851";
const JOB_ID = "00000000-0000-4000-a000-000000000852";
const payload: RecordsSalesforceSyncPayload = {
  processingJobId: JOB_ID,
  orgId: "org-a",
  appId: "crm",
  sourceInstanceId: "salesforce-production",
};

function review() {
  return createSalesforceSchemaReview({
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
      salesforce_schema_review: review(),
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

function state(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-a",
    appId: "crm",
    appStatus: "active",
    mode: "mirror" as const,
    sourceInstanceId: "salesforce-production",
    exportActionRequestId: ACTION_ID,
    objects: [
      {
        sourceApiName: "Account",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      },
    ],
    enabled: true,
    intervalMinutes: 15,
    status: "queued",
    lastEnqueuedAt: "2026-08-02T12:00:00.000Z",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    apiBudget: null,
    cutover: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RecordsSalesforceSyncDependencies> = {},
): RecordsSalesforceSyncDependencies {
  const cursor = {
    orgId: "org-a",
    appId: "crm",
    sourceInstanceId: "salesforce-production",
    objectApiName: "account",
    watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
    lastBatchHash: "manifest:hash",
    updatedAt: new Date("2026-08-02T12:00:00.000Z"),
  };
  return {
    withAppLock: vi.fn(async (_pool, _input, work) => work()),
    getRequest: vi.fn().mockResolvedValue(request()),
    getJob: vi.fn().mockResolvedValue({
      id: JOB_ID,
      orgId: "org-a",
      kind: "records_salesforce_sync",
      status: "queued",
      triggerPayload: {
        app_id: "crm",
        source_instance_id: "salesforce-production",
      },
    }),
    updateJob: vi.fn().mockResolvedValue(true),
    getState: vi.fn().mockResolvedValue(state()),
    updateState: vi.fn().mockResolvedValue(undefined),
    connectorForAction: vi.fn().mockResolvedValue({
      budgetSnapshot: vi.fn().mockReturnValue({
        day: "2026-08-02",
        used: 7,
        limit: 10_000,
      }),
      restoreBudget: vi.fn(),
      delta: vi.fn().mockResolvedValue({
        sourceApiName: "Account",
        records: [{ Id: "001", Name: "Acme" }],
        deletedIds: [],
        nextWatermark: { system_modstamp: "2026-08-02T12:15:00.000Z" },
      }),
    }),
    getCursor: vi.fn().mockResolvedValue(cursor),
    applyDelta: vi.fn().mockResolvedValue({
      appId: "crm",
      objectApiName: "account",
      sourceApiName: "Account",
      batchHash: "a".repeat(64),
      upserts: 1,
      deletes: 0,
      noOps: 0,
      replays: 0,
      cursor,
    }),
    mirrorWatermarks: vi.fn().mockResolvedValue(undefined),
    assertStorage: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(new Date("2026-08-02T12:15:00.000Z")),
    ...overrides,
  };
}

const writer = { execute: vi.fn() } as unknown as Pick<RecordWriteExecutor, "execute">;
const pool = {} as Pool;

describe("Salesforce scheduled delta sync", () => {
  it("loads the authoritative cursor and applies an approved mapping", async () => {
    const deps = dependencies();
    await runRecordsSalesforceSync(writer, pool, payload, deps);

    expect(deps.assertStorage).toHaveBeenCalledOnce();
    expect(deps.getCursor).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
      objectApiName: "account",
    });
    const connector = await vi.mocked(deps.connectorForAction).mock.results[0]!.value;
    expect(connector.delta).toHaveBeenCalledWith({
      sourceApiName: "Account",
      watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
    });
    expect(deps.applyDelta).toHaveBeenCalledWith(
      expect.objectContaining({
        pool,
        writer,
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        objectApiName: "account",
        mapping: expect.objectContaining({
          sourceObject: "Account",
          targetObject: "account",
        }),
      }),
    );
    expect(deps.mirrorWatermarks).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "crm" }),
      [
        expect.objectContaining({
          sourceApiName: "Account",
          objectApiName: "account",
          watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
        }),
      ],
    );
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      JOB_ID,
      expect.objectContaining({ status: "succeeded" }),
      ["running"],
    );
    expect(deps.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "crm" }),
      expect.objectContaining({ status: "succeeded", lastError: null }),
    );
  });

  it("cancels a disabled or cut-over schedule before resolving credentials", async () => {
    const deps = dependencies({
      getState: vi.fn().mockResolvedValue(state({ enabled: false })),
    });
    await runRecordsSalesforceSync(writer, pool, payload, deps);
    expect(deps.connectorForAction).not.toHaveBeenCalled();
    expect(deps.updateJob).toHaveBeenCalledWith(
      "org-a",
      JOB_ID,
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("allows only the cutover-bound final delta while scheduling is frozen", async () => {
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValue({
        id: JOB_ID,
        orgId: "org-a",
        kind: "records_salesforce_sync",
        status: "queued",
        triggerPayload: {
          app_id: "crm",
          source_instance_id: "salesforce-production",
          final_delta: true,
          cutover_job_id: "00000000-0000-4000-a000-000000000853",
        },
      }),
      getState: vi.fn().mockResolvedValue(
        state({
          mode: "cutting_over",
          enabled: false,
          cutover: {
            actionRequestId: "00000000-0000-4000-a000-000000000854",
            processingJobId: "00000000-0000-4000-a000-000000000853",
            finalSyncJobId: JOB_ID,
            status: "final_sync",
            startedAt: "2026-08-02T12:00:00.000Z",
            completedAt: null,
            lastError: null,
          },
        }),
      ),
    });
    await runRecordsSalesforceSync(writer, pool, payload, deps);
    expect(deps.applyDelta).toHaveBeenCalledOnce();
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      JOB_ID,
      expect.objectContaining({ status: "succeeded" }),
      ["running"],
    );
  });

  it("checkpoints retryable connector failures and lets pg-boss retry", async () => {
    const failure = new SalesforceApiError("Salesforce busy", 503, true);
    const deps = dependencies({
      connectorForAction: vi.fn().mockResolvedValue({
        budgetSnapshot: vi.fn().mockReturnValue({
          day: "2026-08-02",
          used: 5,
          limit: 10_000,
        }),
        restoreBudget: vi.fn(),
        delta: vi.fn().mockRejectedValue(failure),
      }),
    });
    await expect(runRecordsSalesforceSync(writer, pool, payload, deps)).rejects.toBe(failure);
    expect(deps.updateState).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "crm" }),
      expect.objectContaining({ status: "retrying", lastError: "Salesforce busy" }),
    );
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      JOB_ID,
      expect.objectContaining({ status: "retrying", error: "Salesforce busy" }),
    );
  });

  it("rejects a forged job/source binding", async () => {
    const deps = dependencies({
      getJob: vi.fn().mockResolvedValue({
        id: JOB_ID,
        orgId: "org-a",
        kind: "records_salesforce_sync",
        status: "queued",
        triggerPayload: { app_id: "another-app", source_instance_id: "salesforce-production" },
      }),
    });
    await expect(runRecordsSalesforceSync(writer, pool, payload, deps)).rejects.toThrow(
      "does not belong",
    );
    expect(deps.updateJob).not.toHaveBeenCalled();
  });
});
