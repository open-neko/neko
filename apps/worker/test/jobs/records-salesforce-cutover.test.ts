import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { RecordsSalesforceCutoverPayload } from "@neko/db/jobs";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import { SalesforceApiError, type RecordWriteExecutor } from "@neko/records";
import {
  runRecordsSalesforceCutover,
  type RecordsSalesforceCutoverDependencies,
} from "../../src/jobs/records-salesforce-cutover.js";

const ACTION_ID = "00000000-0000-4000-a000-000000000881";
const CUTOVER_ID = "00000000-0000-4000-a000-000000000882";
const SYNC_ID = "00000000-0000-4000-a000-000000000883";
const payload: RecordsSalesforceCutoverPayload = {
  processingJobId: CUTOVER_ID,
  orgId: "org-a",
  appId: "crm",
  sourceInstanceId: "salesforce-production",
};

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
    kind: "records_salesforce_cutover",
    target: null,
    payload: { app: "crm" },
    riskLevel: "high",
    status: "executed",
    summary: "Cut over CRM",
    intent: "Cut over CRM",
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
    mode: "cutting_over" as const,
    sourceInstanceId: "salesforce-production",
    exportActionRequestId: "00000000-0000-4000-a000-000000000880",
    objects: [
      {
        sourceApiName: "Account",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:30:00.000Z" },
      },
    ],
    enabled: false,
    intervalMinutes: 15,
    status: "cutover_frozen",
    lastEnqueuedAt: "2026-08-02T12:00:00.000Z",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    apiBudget: null,
    cutover: {
      actionRequestId: ACTION_ID,
      processingJobId: CUTOVER_ID,
      finalSyncJobId: null,
      status: "queued",
      startedAt: "2026-08-02T12:00:00.000Z",
      completedAt: null,
      lastError: null,
    },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<RecordsSalesforceCutoverDependencies> = {},
): RecordsSalesforceCutoverDependencies {
  return {
    withAppLock: vi.fn(async (_pool, _input, work) => work()),
    getRequest: vi.fn().mockResolvedValue(request()),
    getJob: vi.fn(async (_orgId, id, kind) =>
      kind === "records_salesforce_cutover"
        ? {
            id: CUTOVER_ID,
            kind,
            status: "queued",
            triggerPayload: {
              action_request_id: ACTION_ID,
              app_id: "crm",
              source_instance_id: "salesforce-production",
            },
          }
        : {
            id,
            kind,
            status: "succeeded",
            triggerPayload: {
              app_id: "crm",
              source_instance_id: "salesforce-production",
              cutover_job_id: CUTOVER_ID,
              final_delta: true,
            },
          },
    ),
    updateJob: vi.fn().mockResolvedValue(true),
    getState: vi.fn().mockResolvedValue(state()),
    updateCutover: vi.fn().mockResolvedValue(undefined),
    createFinalSync: vi.fn().mockResolvedValue(SYNC_ID),
    runFinalSync: vi.fn().mockResolvedValue(undefined),
    getCursor: vi.fn().mockResolvedValue({
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
      objectApiName: "account",
      watermark: { system_modstamp: "2026-08-02T12:30:00.000Z" },
      lastBatchHash: "a".repeat(64),
      updatedAt: new Date("2026-08-02T12:30:00.000Z"),
    }),
    completeCutover: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(new Date("2026-08-02T12:30:00.000Z")),
    ...overrides,
  };
}

const writer = { execute: vi.fn() } as unknown as Pick<RecordWriteExecutor, "execute">;
const pool = {} as Pool;

describe("Salesforce cutover job", () => {
  it("runs one final delta, verifies target cursors, then opens local writes", async () => {
    const deps = dependencies();
    await runRecordsSalesforceCutover(writer, pool, payload, deps);

    expect(deps.withAppLock).toHaveBeenCalledWith(pool, payload, expect.any(Function));
    expect(deps.createFinalSync).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cutting_over", enabled: false }),
      CUTOVER_ID,
    );
    expect(deps.runFinalSync).toHaveBeenCalledWith(writer, pool, {
      processingJobId: SYNC_ID,
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
    });
    expect(deps.getCursor).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
      objectApiName: "account",
    });
    expect(deps.completeCutover).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "cutting_over" }),
      "2026-08-02T12:30:00.000Z",
    );
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      CUTOVER_ID,
      "records_salesforce_cutover",
      expect.objectContaining({ status: "succeeded", result: expect.objectContaining({ mode: "primary" }) }),
      ["running"],
    );
  });

  it("does not promote when a mirrored watermark differs from the target cursor", async () => {
    const deps = dependencies({
      getCursor: vi.fn().mockResolvedValue({
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:29:59.000Z" },
        lastBatchHash: "a".repeat(64),
        updatedAt: new Date(),
      }),
    });
    await expect(runRecordsSalesforceCutover(writer, pool, payload, deps)).resolves.toBeUndefined();
    expect(deps.completeCutover).not.toHaveBeenCalled();
    expect(deps.updateCutover).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "crm" }),
      expect.objectContaining({ status: "failed", lastError: expect.stringContaining("not verified") }),
    );
    expect(deps.updateJob).toHaveBeenLastCalledWith(
      "org-a",
      CUTOVER_ID,
      "records_salesforce_cutover",
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("checkpoints transient final-sync failures for pg-boss retry", async () => {
    const failure = new SalesforceApiError("Salesforce busy", 503, true);
    const deps = dependencies({ runFinalSync: vi.fn().mockRejectedValue(failure) });
    await expect(runRecordsSalesforceCutover(writer, pool, payload, deps)).rejects.toBe(failure);
    expect(deps.completeCutover).not.toHaveBeenCalled();
    expect(deps.updateCutover).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: "crm" }),
      expect.objectContaining({ status: "retrying", lastError: "Salesforce busy" }),
    );
  });

  it("repairs the processing job after a crash immediately following promotion", async () => {
    const primary = state({
      mode: "primary",
      status: "disabled",
      cutover: {
        ...state().cutover,
        status: "succeeded",
        completedAt: "2026-08-02T12:30:00.000Z",
      },
    });
    const deps = dependencies({ getState: vi.fn().mockResolvedValue(primary) });
    await runRecordsSalesforceCutover(writer, pool, payload, deps);
    expect(deps.runFinalSync).not.toHaveBeenCalled();
    expect(deps.updateJob).toHaveBeenCalledWith(
      "org-a",
      CUTOVER_ID,
      "records_salesforce_cutover",
      expect.objectContaining({ status: "succeeded", result: expect.objectContaining({ recovered: true }) }),
    );
  });
});
