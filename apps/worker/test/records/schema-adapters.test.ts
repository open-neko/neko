import { describe, expect, it, vi } from "vitest";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import { RetryableActionAdapterError } from "@neko/llm/workflows";
import type {
  PreparedRecordSchemaAction,
  RecordSchemaChange,
} from "@neko/records";
import {
  RECORD_SCHEMA_ACTION_DESCRIPTORS,
  RECORD_SCHEMA_ACTION_KINDS,
  createRecordSchemaActionAdapter,
  createRecordSchemaPreflightHook,
  registerRecordSchemaActions,
} from "../../src/records/schema-adapters.js";

const HASH = "a".repeat(64);

function actionRequest(
  kind = "app_create",
  payload: Record<string, unknown> = { app: "crm", preview_hash: HASH },
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: `request-${kind}`,
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: "admin",
    actorBackend: "codex",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind,
    target: null,
    payload,
    riskLevel: "high",
    status: "approved",
    summary: "schema action",
    intent: "schema action",
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

function change(phase: RecordSchemaChange["phase"]): RecordSchemaChange {
  return {
    id: "change-1",
    orgId: "org-a",
    appId: "crm",
    actionRequestId: "request-app_create",
    desiredRevision: "3",
    catalogRevision: "b".repeat(64),
    artifact: {
      format: "openneko.records.schema-change.v1",
      action: "app_create",
      actorUserId: "admin-1",
      detail: {},
      document: "type crm__account {\n  id: Text! @id\n}\n",
      objects: [],
    },
    previewSql: "CREATE TABLE ...",
    previewHash: HASH,
    phase,
    attempts: 0,
    lastError: null,
  };
}

describe("records schema worker adapters", () => {
  it("publishes all schema kinds as ask-mode actions with concrete examples", () => {
    expect(RECORD_SCHEMA_ACTION_DESCRIPTORS.map((item) => item.kind)).toEqual(
      RECORD_SCHEMA_ACTION_KINDS,
    );
    for (const descriptor of RECORD_SCHEMA_ACTION_DESCRIPTORS) {
      expect(descriptor.default_mode).toBe("ask");
      expect(descriptor.example).toMatchObject({ app: expect.any(String) });
    }
  });

  it("persists the planned preview before returning from request creation", async () => {
    const prepared = {
      payload: { app: "crm", preview_hash: HASH, schema_preview: { app: "crm" } },
    } as PreparedRecordSchemaAction;
    const planner = { prepare: vi.fn().mockResolvedValue(prepared) };
    const updated = actionRequest("app_create", prepared.payload);
    const update = vi.fn().mockResolvedValue(updated);
    const hook = createRecordSchemaPreflightHook(planner, update);

    await expect(hook(actionRequest("app_create", { app: "crm" }))).resolves.toBe(
      updated,
    );
    expect(planner.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "request-app_create",
        actorUserId: "admin-1",
        actorRole: "admin",
      }),
    );
    expect(update).toHaveBeenCalledWith({
      id: "request-app_create",
      orgId: "org-a",
      payload: prepared.payload,
    });
  });

  it("binds execution to the stored hash and resumes the saga", async () => {
    const saga = {
      get: vi.fn().mockResolvedValue(change("planned")),
      approve: vi.fn().mockResolvedValue(change("approved")),
      execute: vi.fn().mockResolvedValue(change("projected")),
    };
    await expect(
      createRecordSchemaActionAdapter("app_create", saga)({
        request: actionRequest(),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "app_create",
      externalRef: "change-1",
      result: { phase: "projected", previewHash: HASH },
    });
    expect(saga.approve).toHaveBeenCalledWith("request-app_create", HASH);
    expect(saga.execute).toHaveBeenCalledWith("request-app_create");
  });

  it("does not re-approve a resumable phase and fails closed on hash drift", async () => {
    const saga = {
      get: vi.fn().mockResolvedValue(change("applying")),
      approve: vi.fn(),
      execute: vi.fn().mockResolvedValue(change("projected")),
    };
    await createRecordSchemaActionAdapter("app_create", saga)({
      request: actionRequest(),
    });
    expect(saga.approve).not.toHaveBeenCalled();

    saga.get.mockResolvedValue({ ...change("planned"), previewHash: "c".repeat(64) });
    await expect(
      createRecordSchemaActionAdapter("app_create", saga)({
        request: actionRequest(),
      }),
    ).rejects.toMatchObject({ code: "records_schema_approval_stale" });
  });

  it("keeps transient saga failures queue-retryable", async () => {
    const transient = Object.assign(new Error("database restarting"), {
      code: "ECONNREFUSED",
    });
    await expect(
      createRecordSchemaActionAdapter("app_create", {
        get: vi.fn().mockRejectedValue(transient),
        approve: vi.fn(),
        execute: vi.fn(),
      })({ request: actionRequest() }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
  });

  it("registers every adapter and one removable global preflight hook", () => {
    const adapters = new Map<string, unknown>();
    const unregister = vi.fn();
    const registerPreflight = vi.fn().mockReturnValue(unregister);
    const returned = registerRecordSchemaActions({
      planner: { prepare: vi.fn() },
      saga: { get: vi.fn(), approve: vi.fn(), execute: vi.fn() },
      registerAdapter: (kind, adapter) => adapters.set(kind, adapter),
      registerPreflight,
    });
    expect([...adapters.keys()]).toEqual(RECORD_SCHEMA_ACTION_KINDS);
    expect(registerPreflight).toHaveBeenCalledTimes(1);
    returned();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
