import { describe, expect, it, vi } from "vitest";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import { RetryableActionAdapterError } from "@neko/llm/workflows";
import {
  RecordsGraphjinRequestError,
  type RecordWriteRequest,
  type RecordWriteResult,
} from "@neko/records";
import {
  RECORD_ACTION_DESCRIPTORS,
  RECORD_ACTION_KINDS,
  RecordActionPayloadError,
  createRecordActionAdapter,
  includeRecordActionDescriptors,
  registerRecordActionAdapters,
} from "../../src/records/adapters.js";
import { RECORD_SCHEMA_ACTION_KINDS } from "../../src/records/schema-adapters.js";
import { RECORD_IMPORT_ACTION_KINDS } from "../../src/records/import-adapters.js";
import { RECORD_IDENTITY_ACTION_DESCRIPTORS } from "../../src/records/identity-adapters.js";
import { RECORD_SALESFORCE_ACTION_DESCRIPTORS } from "../../src/records/salesforce-adapters.js";
import { RECORD_ARTIFACT_IMPORT_ACTION_DESCRIPTORS } from "../../src/records/artifact-import-adapters.js";

function actionRequest(
  kind: string,
  payload: Record<string, unknown>,
  actor: { userId?: string | null; role?: string | null } = {},
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: `request-${kind}`,
    orgId: "org-a",
    actorUserId: actor.userId === undefined ? "member-1" : actor.userId,
    actorRole: actor.role === undefined ? "member" : actor.role,
    actorBackend: "codex",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind,
    target: null,
    payload,
    riskLevel: "medium",
    status: "approved",
    summary: "test record action",
    intent: "test",
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

function outcome(request: RecordWriteRequest): RecordWriteResult {
  return {
    actionRequestId: request.actionRequestId,
    appId: request.appId,
    objectApiName: request.objectApiName,
    tableName: `${request.appId}__${request.objectApiName}`,
    id: request.id ?? "generated-id",
    operation: request.operation,
    mutationId: "mutation-1",
    replayed: false,
    recovered: false,
  };
}

describe("records worker action adapters", () => {
  it("registers all four ask-mode kinds with concrete payload examples", () => {
    const registered = new Map<string, unknown>();
    registerRecordActionAdapters(
      { execute: vi.fn() },
      (kind, adapter) => registered.set(kind, adapter),
    );
    expect([...registered.keys()]).toEqual(RECORD_ACTION_KINDS);
    expect(RECORD_ACTION_DESCRIPTORS.map((descriptor) => descriptor.kind)).toEqual(
      RECORD_ACTION_KINDS,
    );
    for (const descriptor of RECORD_ACTION_DESCRIPTORS) {
      expect(descriptor.default_mode).toBe("ask");
      expect(descriptor.scope).toBe("internal");
      expect(descriptor.example).toMatchObject({ app: "crm" });
    }
    const descriptors = includeRecordActionDescriptors([
      {
        kind: "record_create",
        description: "must not override the built-in",
      },
      { kind: "send_message", description: "Send a message" },
    ]);
    expect(descriptors.map((descriptor) => descriptor.kind)).toEqual([
      ...RECORD_ACTION_KINDS,
      ...RECORD_SCHEMA_ACTION_KINDS,
      ...RECORD_IMPORT_ACTION_KINDS,
      ...RECORD_IDENTITY_ACTION_DESCRIPTORS.map((descriptor) => descriptor.kind),
      ...RECORD_SALESFORCE_ACTION_DESCRIPTORS.map((descriptor) => descriptor.kind),
      ...RECORD_ARTIFACT_IMPORT_ACTION_DESCRIPTORS.map((descriptor) => descriptor.kind),
      "send_message",
    ]);
    expect(
      descriptors
        .slice(0, RECORD_ACTION_KINDS.length)
        .every((descriptor) => descriptor.scope === "internal"),
    ).toBe(true);
    expect(descriptors.at(-1)?.scope).toBeUndefined();
  });

  it("maps create and update payloads through the snapshotted actor", async () => {
    const execute = vi.fn(async (request: RecordWriteRequest) =>
      outcome(request),
    );
    const create = createRecordActionAdapter("record_create", { execute });
    await expect(
      create({
        request: actionRequest(
          "record_create",
          { app: "crm", object: "contact", fields: { lastname: "Rivera" } },
          { userId: null, role: "admin" },
        ),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "record_create",
      externalRef: "crm__contact:generated-id",
    });
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "create",
        actor: {
          userId: "urn:openneko:solo-admin:org-a",
          role: "admin",
        },
        fields: { lastname: "Rivera" },
      }),
    );

    const update = createRecordActionAdapter("record_update", { execute });
    await update({
      request: actionRequest("record_update", {
        app: "crm",
        object: "opportunity",
        id: "opp-1",
        fields: { stage: "won" },
        expected: { stage: "proposal" },
      }),
    });
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        operation: "update",
        id: "opp-1",
        actor: { userId: "member-1", role: "member" },
        fields: { stage: "won" },
        expected: { stage: "proposal" },
      }),
    );
  });

  it("maps delete and restore to typed soft-delete operations", async () => {
    const execute = vi.fn(async (request: RecordWriteRequest) =>
      outcome(request),
    );
    for (const kind of ["record_delete", "record_restore"] as const) {
      await createRecordActionAdapter(kind, { execute })({
        request: actionRequest(kind, {
          app: "crm",
          object: "contact",
          id: "contact-1",
        }),
      });
    }
    expect(execute.mock.calls.map(([request]) => request.operation)).toEqual([
      "delete",
      "restore",
    ]);
  });

  it("fails closed for malformed payloads and missing human identity", async () => {
    const adapter = createRecordActionAdapter("record_update", {
      execute: vi.fn(),
    });
    await expect(
      adapter({
        request: actionRequest("record_update", {
          app: "crm",
          object: "contact",
          id: "contact-1",
          fields: {},
          typo: true,
        }),
      }),
    ).rejects.toBeInstanceOf(RecordActionPayloadError);
    await expect(
      adapter({
        request: actionRequest(
          "record_update",
          { app: "crm", object: "contact", id: "contact-1", fields: {} },
          { userId: null, role: "member" },
        ),
      }),
    ).rejects.toThrow(/linked member identity/);
    await expect(
      adapter({
        request: actionRequest(
          "record_update",
          { app: "crm", object: "contact", id: "contact-1", fields: {} },
          { userId: null, role: "service" },
        ),
      }),
    ).rejects.toThrow(/admin or member/);
  });

  it("marks only uncertain infrastructure failures as queue-retryable", async () => {
    const request = actionRequest("record_delete", {
      app: "crm",
      object: "contact",
      id: "contact-1",
    });
    await expect(
      createRecordActionAdapter("record_delete", {
        execute: vi
          .fn()
          .mockRejectedValue(new RecordsGraphjinRequestError("unavailable", null)),
      })({ request }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
    await expect(
      createRecordActionAdapter("record_delete", {
        execute: vi
          .fn()
          .mockRejectedValue(new RecordsGraphjinRequestError("forbidden", 403)),
      })({ request }),
    ).rejects.toBeInstanceOf(RecordsGraphjinRequestError);
  });
});
