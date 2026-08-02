import { describe, expect, it, vi } from "vitest";
import {
  RecordsGraphjinRequestError,
  type RecordOwnerBackfillRequest,
} from "@neko/records";
import {
  RetryableActionAdapterError,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  RECORD_IDENTITY_ACTION_DESCRIPTORS,
  RecordIdentityActionPayloadError,
  createRecordIdentityActionAdapter,
  registerRecordIdentityActions,
} from "../../src/records/identity-adapters.js";

function actionRequest(
  payload: Record<string, unknown>,
  role = "admin",
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: "request-backfill",
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: role,
    actorBackend: "web-identity",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind: "records_identity_backfill",
    target: "record-identity:crm/sf-prod",
    payload,
    riskLevel: "medium",
    status: "approved",
    summary: "backfill owners",
    intent: "backfill owners",
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

function report(request: RecordOwnerBackfillRequest) {
  return {
    actionRequestId: request.actionRequestId,
    appId: request.appId,
    sourceInstanceId: request.sourceInstanceId,
    sourceUserId: request.sourceUserId ?? null,
    mappings: 1,
    objects: 2,
    scanned: 4,
    updated: 3,
    unchanged: 1,
    skippedObjects: [],
    replayed: false,
  };
}

describe("records identity action adapter", () => {
  it("publishes one internal ask-mode action and registers it", () => {
    expect(RECORD_IDENTITY_ACTION_DESCRIPTORS).toEqual([
      expect.objectContaining({
        kind: "records_identity_backfill",
        scope: "internal",
        default_mode: "ask",
      }),
    ]);
    const registered = vi.fn();
    registerRecordIdentityActions({ execute: vi.fn() }, registered);
    expect(registered.mock.calls.map(([kind]) => kind)).toEqual([
      "records_identity_backfill",
      "records_identity_backfill_lazy",
      "records_identity_backfill_import",
    ]);
  });

  it("executes an exact source-scoped request under the snapshotted admin", async () => {
    const execute = vi.fn(async (request: RecordOwnerBackfillRequest) => report(request));
    const adapter = createRecordIdentityActionAdapter("records_identity_backfill", {
      execute,
    });
    await expect(
      adapter({
        request: actionRequest({
          app: "crm",
          source_instance_id: "sf-prod",
          source_user_id: "005-alice",
        }),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "records_identity_backfill",
      externalRef: "crm:sf-prod",
      result: { updated: 3 },
    });
    expect(execute).toHaveBeenCalledWith({
      actionRequestId: "request-backfill",
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "sf-prod",
      sourceUserId: "005-alice",
      actorUserId: "admin-1",
    });
  });

  it("rejects non-admin and unknown payload fields", async () => {
    const adapter = createRecordIdentityActionAdapter("records_identity_backfill", {
      execute: vi.fn(),
    });
    await expect(
      adapter({
        request: actionRequest(
          { app: "crm", source_instance_id: "sf-prod" },
          "member",
        ),
      }),
    ).rejects.toBeInstanceOf(RecordIdentityActionPayloadError);
    await expect(
      adapter({
        request: actionRequest({
          app: "crm",
          source_instance_id: "sf-prod",
          org_id: "org-other",
        }),
      }),
    ).rejects.toThrow(/unknown payload field/);
  });

  it("marks transient GraphJin failures retryable", async () => {
    const adapter = createRecordIdentityActionAdapter("records_identity_backfill", {
      execute: vi
        .fn()
        .mockRejectedValue(new RecordsGraphjinRequestError("down", 503)),
    });
    await expect(
      adapter({
        request: actionRequest({ app: "crm", source_instance_id: "sf-prod" }),
      }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
  });

  it("accepts lazy actions only from the identity-link worker for that user", async () => {
    const execute = vi.fn(async (request: RecordOwnerBackfillRequest) => report(request));
    const adapter = createRecordIdentityActionAdapter("records_identity_backfill_lazy", {
      execute,
    });
    const trusted = actionRequest({
      app: "crm",
      source_instance_id: "sf-prod",
      source_user_id: "005-alice",
      linked_app_user_id: "admin-1",
    });
    trusted.kind = "records_identity_backfill_lazy";
    trusted.actorBackend = "records-identity-link";
    await expect(adapter({ request: trusted })).resolves.toMatchObject({
      result: { updated: 3 },
    });

    const forged = { ...trusted, actorBackend: "codex" };
    await expect(adapter({ request: forged })).rejects.toThrow(/trusted identity-link worker/);
  });

  it("accepts import backfills only from the trusted artifact worker", async () => {
    const execute = vi.fn(async (request: RecordOwnerBackfillRequest) => report(request));
    const adapter = createRecordIdentityActionAdapter(
      "records_identity_backfill_import",
      { execute },
    );
    const trusted = actionRequest({
      app: "crm",
      source_instance_id: "sf-prod",
      import_action_request_id: "import-request-1",
    });
    trusted.kind = "records_identity_backfill_import";
    trusted.actorBackend = "records-artifact-import";
    await expect(adapter({ request: trusted })).resolves.toMatchObject({
      result: { updated: 3 },
    });
    await expect(
      adapter({ request: { ...trusted, actorBackend: "codex" } }),
    ).rejects.toThrow(/trusted artifact-import worker/);
  });
});
