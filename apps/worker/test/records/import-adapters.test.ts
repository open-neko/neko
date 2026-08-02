import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  buildRecordImportPlan,
  recordIdentifier,
  type AppRegistrySnapshot,
  type RecordRegistry,
} from "@neko/records";
import {
  RECORD_IMPORT_ACTION_DESCRIPTORS,
  RECORD_IMPORT_ACTION_KINDS,
  RecordImportActionPayloadError,
  createRecordImportActionAdapter,
  createRecordImportPreflightHook,
  registerRecordImportActions,
} from "../../src/records/import-adapters.js";

const objectId = "00000000-0000-0000-0000-000000000981";

function snapshot(): AppRegistrySnapshot {
  return {
    revision: "1",
    app: {
      orgId: "org-a",
      appId: "equipment",
      label: "Equipment",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "1",
    },
    objects: [
      {
        id: objectId,
        orgId: "org-a",
        appId: "equipment",
        apiName: recordIdentifier("loan"),
        sourceApiName: null,
        label: "Loan",
        pluralLabel: "Loans",
        tableSchema: recordIdentifier("public"),
        tableName: recordIdentifier("equipment__loan"),
        nameField: recordIdentifier("name"),
        visibility: "org",
        custom: false,
        archivedAt: null,
        recordCount: null,
      },
    ],
    fields: [
      {
        id: "00000000-0000-0000-0000-000000000982",
        orgId: "org-a",
        objectId,
        apiName: recordIdentifier("name"),
        sourceApiName: null,
        label: "Name",
        kind: "text",
        columnName: recordIdentifier("name"),
        required: true,
        readOnly: false,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: null,
        length: null,
        scale: null,
      },
    ],
    layouts: [],
    pages: [],
    permissions: [],
  };
}

function actionRequest(
  kind: string,
  payload: Record<string, unknown>,
  role = "admin",
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: `request-${kind}`,
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: role,
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
    summary: "import records",
    intent: "import records",
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

describe("records import worker adapters", () => {
  it("publishes start, status, and cancel with safe defaults", () => {
    expect(RECORD_IMPORT_ACTION_DESCRIPTORS.map((item) => item.kind)).toEqual(
      RECORD_IMPORT_ACTION_KINDS,
    );
    expect(RECORD_IMPORT_ACTION_DESCRIPTORS[0]?.default_mode).toBe("ask");
    expect(RECORD_IMPORT_ACTION_DESCRIPTORS[1]?.default_mode).toEqual({
      internal: "auto",
    });
    expect(RECORD_IMPORT_ACTION_DESCRIPTORS[2]?.default_mode).toBe("ask");
  });

  it("reads the staged CSV and persists the reviewable plan before approval", async () => {
    const bytes = Buffer.from("id,name,Notes\nloan-1,Laptop,Ready\n");
    const registry = {
      loadApp: vi.fn().mockResolvedValue(snapshot()),
    } as unknown as RecordRegistry;
    const readSource = vi.fn().mockResolvedValue(bytes);
    const updatePayload = vi.fn(async (input: {
      id: string;
      orgId: string;
      payload: Record<string, unknown>;
    }) => actionRequest("records_import_start", input.payload));
    const hook = createRecordImportPreflightHook({
      pool: {} as Pool,
      registry,
      readSource,
      updatePayload: updatePayload as never,
    });
    const prepared = await hook(
      actionRequest("records_import_start", {
        app: "equipment",
        object: "loan",
        source_path: "uploads/thread-1/loans.csv",
      }),
    );

    expect(readSource).toHaveBeenCalledWith(
      "org-a",
      "uploads/thread-1/loans.csv",
    );
    expect(prepared?.payload).toMatchObject({
      app: "equipment",
      object: "loan",
      source_name: "loans.csv",
      mapping: { id: "id", name: "name", Notes: null },
      import_plan: {
        rowCount: 1,
        sampleRows: [{ id: "loan-1", name: "Laptop", Notes: "Ready" }],
        warnings: ["Notes is not mapped and will be ignored"],
      },
    });
  });

  it("creates one durable run and queues it after approval", async () => {
    const bytes = Buffer.from("id,name\nloan-1,Laptop\n");
    const plan = buildRecordImportPlan({
      snapshot: snapshot(),
      objectApiName: "loan",
      sourcePath: "uploads/thread-1/loans.csv",
      sourceName: "loans.csv",
      bytes,
    });
    const now = new Date("2026-08-02T12:00:00.000Z");
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "00000000-0000-4000-a000-000000000983",
          org_id: "org-a",
          app_id: "equipment",
          action_request_id: "request-records_import_start",
          source_instance_id: null,
          status: "planned",
          plan_hash: plan.planHash,
          current_stage: "manifest",
          result: { plan },
          error: null,
          cancel_requested_at: null,
          created_at: now,
          updated_at: now,
        },
      ],
      rowCount: 1,
    });
    const enqueueImport = vi.fn().mockResolvedValue("job-1");
    const request = actionRequest("records_import_start", {
      app: "equipment",
      object: "loan",
      source_path: plan.source.path,
      source_name: plan.source.name,
      duplicate_key: plan.duplicateKey,
      batch_size: plan.batchSize,
      owner_user_id: null,
      mapping: { id: "id", name: "name" },
      import_plan: plan,
    });
    await expect(
      createRecordImportActionAdapter("records_import_start", {
        pool: { query } as unknown as Pool,
        enqueueImport,
      })({ request }),
    ).resolves.toMatchObject({
      commandOrOperation: "records_import_start",
      externalRef: "00000000-0000-4000-a000-000000000983",
      result: { jobId: "job-1", status: "planned", sourceRows: 1 },
    });
    expect(enqueueImport).toHaveBeenCalledWith({
      orgId: "org-a",
      importRunId: "00000000-0000-4000-a000-000000000983",
      actorUserId: "admin-1",
    });
  });

  it("fails closed on non-admin actors and plan drift", async () => {
    const bytes = Buffer.from("id,name\nloan-1,Laptop\n");
    const plan = buildRecordImportPlan({
      snapshot: snapshot(),
      objectApiName: "loan",
      sourcePath: "uploads/thread-1/loans.csv",
      sourceName: "loans.csv",
      bytes,
    });
    const payload = {
      app: "equipment",
      object: "loan",
      source_path: plan.source.path,
      source_name: plan.source.name,
      duplicate_key: plan.duplicateKey,
      batch_size: plan.batchSize,
      owner_user_id: null,
      mapping: { id: "id", name: "name" },
      import_plan: plan,
    };
    const adapter = createRecordImportActionAdapter("records_import_start", {
      pool: {} as Pool,
      enqueueImport: vi.fn(),
    });
    await expect(
      adapter({ request: actionRequest("records_import_start", payload, "member") }),
    ).rejects.toBeInstanceOf(RecordImportActionPayloadError);
    await expect(
      adapter({
        request: actionRequest("records_import_start", {
          ...payload,
          import_plan: { ...plan, batchSize: plan.batchSize + 1 },
        }),
      }),
    ).rejects.toThrow(/changed after approval/i);
  });

  it("registers all adapters and one removable preflight hook", () => {
    const adapters = new Map<string, unknown>();
    const unregister = vi.fn();
    const registerPreflight = vi.fn().mockReturnValue(unregister);
    const returned = registerRecordImportActions({
      pool: {} as Pool,
      readSource: vi.fn(),
      enqueueImport: vi.fn(),
      registerAdapter: (kind, adapter) => adapters.set(kind, adapter),
      registerPreflight,
    });
    expect([...adapters.keys()]).toEqual(RECORD_IMPORT_ACTION_KINDS);
    expect(registerPreflight).toHaveBeenCalledTimes(1);
    returned();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});

