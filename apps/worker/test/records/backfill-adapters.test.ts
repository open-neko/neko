import type { ActionRequestRecord } from "@neko/llm/workflows";
import { RetryableActionAdapterError } from "@neko/llm/workflows";
import {
  RecordBackfillAuditError,
  type RecordBackfillReport,
  type RecordBackfillRequest,
} from "@neko/records";
import { describe, expect, it, vi } from "vitest";
import {
  RECORD_BACKFILL_ACTION_DESCRIPTORS,
  RecordBackfillActionPayloadError,
  createRecordBackfillActionAdapter,
  registerRecordBackfillAction,
} from "../../src/records/backfill-adapters.js";

function actionRequest(
  payload: Record<string, unknown>,
  role = "admin",
): ActionRequestRecord {
  const at = new Date("2026-08-03T06:00:00.000Z");
  return {
    id: "request-backfill",
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: role,
    actorBackend: "codex",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind: "record_backfill",
    target: "record:crm/account",
    payload,
    riskLevel: "high",
    status: "approved",
    summary: "Backfill account revenue",
    intent: "Replace a legacy field additively",
    minutesSaved: null,
    minutesSavedBasis: null,
    workRunId: null,
    requestedByRunId: null,
    approvedByUserId: "admin-1",
    approvedAt: at,
    rejectionReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

function report(request: RecordBackfillRequest): RecordBackfillReport {
  return {
    actionRequestId: request.actionRequestId,
    appId: request.appId,
    objectApiName: request.objectApiName,
    targetFieldApiName: request.targetFieldApiName,
    sourceFieldApiName:
      typeof request.sourceFieldApiName === "string"
        ? request.sourceFieldApiName
        : null,
    transform: request.transform ?? null,
    scanned: 2,
    updated: 2,
    skippedNullSource: 0,
    remainingNull: 0,
    replayed: false,
  };
}

describe("record backfill action adapter", () => {
  it("publishes and registers one internal ask-mode action", () => {
    expect(RECORD_BACKFILL_ACTION_DESCRIPTORS).toEqual([
      expect.objectContaining({
        kind: "record_backfill",
        scope: "internal",
        default_mode: "ask",
      }),
    ]);
    const registered = vi.fn();
    registerRecordBackfillAction({ execute: vi.fn() }, registered);
    expect(registered).toHaveBeenCalledWith(
      "record_backfill",
      expect.any(Function),
    );
  });

  it("maps an explicit source transform under the snapshotted admin", async () => {
    const execute = vi.fn(async (request: RecordBackfillRequest) =>
      report(request),
    );
    const adapter = createRecordBackfillActionAdapter({ execute });
    await expect(
      adapter({
        request: actionRequest({
          app: "crm",
          object: "account",
          from: "annual_revenue_text",
          to: "annual_revenue",
          transform: "decimal",
        }),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "record_backfill",
      externalRef: "crm:account.annual_revenue",
      result: { updated: 2 },
    });
    expect(execute).toHaveBeenCalledWith({
      actionRequestId: "request-backfill",
      orgId: "org-a",
      appId: "crm",
      objectApiName: "account",
      sourceFieldApiName: "annual_revenue_text",
      targetFieldApiName: "annual_revenue",
      transform: "decimal",
      actorUserId: "admin-1",
    });
  });

  it("accepts a constant and rejects ambiguous or non-admin payloads", async () => {
    const execute = vi.fn(async (request: RecordBackfillRequest) =>
      report(request),
    );
    const adapter = createRecordBackfillActionAdapter({ execute });
    await adapter({
      request: actionRequest({
        app: "crm",
        object: "account",
        to: "region",
        value: "unknown",
      }),
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: "unknown" }),
    );

    for (const request of [
      actionRequest({
        app: "crm",
        object: "account",
        from: "old",
        to: "new",
        value: "also-set",
      }),
      actionRequest(
        { app: "crm", object: "account", to: "region", value: "unknown" },
        "member",
      ),
      actionRequest({
        app: "crm",
        object: "account",
        from: "old",
        to: "new",
        transform: "guess",
      }),
    ]) {
      await expect(adapter({ request })).rejects.toBeInstanceOf(
        RecordBackfillActionPayloadError,
      );
    }
  });

  it("marks uncertain audit failures retryable", async () => {
    const adapter = createRecordBackfillActionAdapter({
      execute: vi.fn().mockRejectedValue(new RecordBackfillAuditError()),
    });
    await expect(
      adapter({
        request: actionRequest({
          app: "crm",
          object: "account",
          to: "region",
          value: "unknown",
        }),
      }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
  });
});
