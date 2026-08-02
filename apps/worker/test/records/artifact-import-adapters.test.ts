import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  buildRecordArtifactImportPlan,
  RecordsSchemaApprovalStaleError,
  type RecordSchemaChange,
} from "@neko/records";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  RECORD_ARTIFACT_IMPORT_ACTION_DESCRIPTORS,
  RECORD_ARTIFACT_IMPORT_ACTION_KINDS,
  RecordArtifactImportActionPayloadError,
  createRecordArtifactImportActionAdapter,
  createRecordArtifactImportPreflightHook,
  registerRecordArtifactImportActions,
  type RecordArtifactImportActionDependencies,
} from "../../src/records/artifact-import-adapters.js";

const ACTION_ID = "00000000-0000-4000-a000-000000000821";
const directory = "imports/salesforce/00000000-0000-4000-a000-000000000822";
const csv = Buffer.from("Id,Name\n001A000010khO8J,Acme\n");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stagedFiles() {
  return new Map<string, Uint8Array>([
    [
      `${directory}/export-manifest.json`,
      Buffer.from(
        JSON.stringify({
          format: "openneko.records.artifact.v1",
          source: {
            kind: "salesforce",
            instance_id: "salesforce-production",
            mode: "mirror",
          },
          generated_at: "2026-08-02T12:00:00.000Z",
          watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
          objects: [
            {
              source_api_name: "Account",
              object_api_name: "account",
              data_path: "data/account.csv",
              describe_path: "describe/account.json",
              expected_rows: 1,
              sha256: sha256(csv),
              watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
            },
          ],
        }),
      ),
    ],
    [
      `${directory}/describe/account.json`,
      Buffer.from(
        JSON.stringify({
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
        }),
      ),
    ],
    [`${directory}/data/account.csv`, csv],
  ]);
}

async function plan() {
  const files = stagedFiles();
  return buildRecordArtifactImportPlan({
    directory,
    app: "crm",
    label: "CRM",
    readFile: async (path) => files.get(path)!,
  });
}

function request(
  kind: string,
  payload: Record<string, unknown>,
  backend = kind === "records_artifact_import_from_export"
    ? "records-salesforce-export"
    : "codex",
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: ACTION_ID,
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: "admin",
    actorBackend: backend,
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: "internal",
    kind,
    target: null,
    payload,
    riskLevel: "high",
    status: "approved",
    summary: "Import connector artifact",
    intent: "Import connector artifact",
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
    id: "00000000-0000-4000-a000-000000000823",
    orgId: "org-a",
    appId: "crm",
    actionRequestId: ACTION_ID,
    desiredRevision: "1",
    catalogRevision: "catalog",
    artifact: {
      format: "openneko.records.schema-change.v1",
      action: "app_create",
      actorUserId: "admin-1",
      detail: {},
      document: "type crm__account { id: Text! @id }",
      objects: [],
    },
    previewSql: "create table crm__account",
    previewHash: "a".repeat(64),
    phase,
    attempts: 0,
    lastError: null,
  };
}

function poolForRun() {
  return {
    query: vi.fn(async (_query: string, values: unknown[]) => ({
      rowCount: 1,
      rows: [
        {
          id: values[0],
          org_id: values[1],
          app_id: "crm",
          action_request_id: values[3],
          source_instance_id: values[4],
          status: "planned",
          plan_hash: values[5],
          current_stage: "manifest",
          result: JSON.parse(String(values[6])),
          error: null,
          cancel_requested_at: null,
          created_at: new Date("2026-08-02T12:00:00.000Z"),
          updated_at: new Date("2026-08-02T12:00:00.000Z"),
        },
      ],
    })),
  } as unknown as Pool;
}

describe("artifact import worker actions", () => {
  it("publishes one reviewed action while retaining a hidden trusted chain kind", () => {
    expect(RECORD_ARTIFACT_IMPORT_ACTION_DESCRIPTORS.map(({ kind }) => kind)).toEqual([
      "records_artifact_import_start",
    ]);
    expect(RECORD_ARTIFACT_IMPORT_ACTION_KINDS).toEqual([
      "records_artifact_import_start",
      "records_artifact_import_from_export",
    ]);
  });

  it("preflights the immutable artifact and the matching app_create schema", async () => {
    const files = stagedFiles();
    const planner = {
      prepare: vi.fn().mockResolvedValue({
        payload: {
          preview_hash: "a".repeat(64),
          schema_preview: { app: "crm", objects: 1 },
        },
      }),
    };
    const updatePayload = vi.fn(async (input: {
      payload: Record<string, unknown>;
    }) => request("records_artifact_import_start", input.payload));
    const hook = createRecordArtifactImportPreflightHook({
      planner,
      readSource: async (_orgId, path) => files.get(path)!,
      updatePayload: updatePayload as never,
    });
    const prepared = await hook(
      request("records_artifact_import_start", {
        artifact_path: directory,
        app: "crm",
        label: "CRM",
      }),
    );
    expect(planner.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "app_create", actorRole: "admin" }),
    );
    expect(prepared?.payload).toMatchObject({
      app: "crm",
      artifact_path: directory,
      preview_hash: "a".repeat(64),
      artifact_import_plan: {
        format: "openneko.records.artifact-import.v1",
        imports: [expect.objectContaining({ objectApiName: "account" })],
      },
    });
  });

  it("accepts only the exported artifact covered by the reviewed schema", async () => {
    const files = stagedFiles();
    const artifactPlan = await plan();
    const planner = {
      prepare: vi.fn().mockResolvedValue({
        payload: {
          preview_hash: "a".repeat(64),
          schema_preview: { app: "crm", objects: 1 },
        },
      }),
    };
    const updatePayload = vi.fn(async (input: {
      payload: Record<string, unknown>;
    }) => request("records_artifact_import_from_export", input.payload));
    const hook = createRecordArtifactImportPreflightHook({
      planner,
      readSource: async (_orgId, path) => files.get(path)!,
      updatePayload: updatePayload as never,
    });
    const original = {
      artifact_path: directory,
      app: "crm",
      label: "CRM",
      export_job_id: "00000000-0000-4000-a000-000000000822",
      source_instance_id: "salesforce-production",
      approved_schema_hash: artifactPlan.sourceSchemaHash,
    };
    await expect(
      hook(request("records_artifact_import_from_export", original)),
    ).resolves.toMatchObject({
      payload: {
        source_instance_id: "salesforce-production",
        approved_schema_hash: artifactPlan.sourceSchemaHash,
      },
    });
    await expect(
      hook(
        request("records_artifact_import_from_export", {
          ...original,
          approved_schema_hash: "b".repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(RecordsSchemaApprovalStaleError);
  });

  it("projects schema, creates deterministic child runs, and queues every object", async () => {
    const artifactPlan = await plan();
    const enqueueImport = vi.fn().mockResolvedValue("boss-import-1");
    const dependencies: RecordArtifactImportActionDependencies = {
      pool: poolForRun(),
      saga: {
        get: vi.fn().mockResolvedValue(change("planned")),
        approve: vi.fn().mockResolvedValue(change("approved")),
        execute: vi.fn().mockResolvedValue(change("projected")),
      },
      enqueueImport,
      stageState: vi.fn(),
      trackRuns: vi.fn(),
      failState: vi.fn(),
    };
    const action = request("records_artifact_import_from_export", {
      artifact_path: directory,
      app: "crm",
      label: "CRM",
      purpose: artifactPlan.definition.purpose,
      batch_size: 100,
      owner_user_id: null,
      export_job_id: "00000000-0000-4000-a000-000000000822",
      source_instance_id: "salesforce-production",
      approved_schema_hash: artifactPlan.sourceSchemaHash,
      artifact_import_plan: artifactPlan,
      preview_hash: "a".repeat(64),
      schema_preview: { app: "crm" },
    });
    await expect(
      createRecordArtifactImportActionAdapter(
        "records_artifact_import_from_export",
        dependencies,
      )({ request: action }),
    ).resolves.toMatchObject({
      result: {
        appId: "crm",
        mode: "mirror",
        schemaPhase: "projected",
        jobs: [expect.objectContaining({ objectApiName: "account", jobId: "boss-import-1" })],
      },
    });
    expect(enqueueImport).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", actorUserId: "admin-1" }),
    );
    expect(dependencies.trackRuns).toHaveBeenCalledWith(
      action,
      artifactPlan,
      [expect.any(String)],
    );
    const rawPool = dependencies.pool as unknown as { query: ReturnType<typeof vi.fn> };
    expect(rawPool.query.mock.calls[0]?.[1]?.[3]).toBe(
      `${ACTION_ID}:artifact:account`,
    );
  });

  it("rejects attempts to invoke the hidden chain kind from another backend", async () => {
    const artifactPlan = await plan();
    const adapter = createRecordArtifactImportActionAdapter(
      "records_artifact_import_from_export",
      {
        pool: poolForRun(),
        saga: { get: vi.fn(), approve: vi.fn(), execute: vi.fn() },
        enqueueImport: vi.fn(),
        stageState: vi.fn(),
        trackRuns: vi.fn(),
        failState: vi.fn(),
      },
    );
    await expect(
      adapter({
        request: request(
          "records_artifact_import_from_export",
          {
            artifact_path: directory,
            app: "crm",
            artifact_import_plan: artifactPlan,
          },
          "codex",
        ),
      }),
    ).rejects.toBeInstanceOf(RecordArtifactImportActionPayloadError);
  });

  it("registers both adapters and one preflight hook", () => {
    const adapters: string[] = [];
    const hook = vi.fn();
    const unregister = vi.fn();
    registerRecordArtifactImportActions({
      pool: poolForRun(),
      planner: { prepare: vi.fn() },
      saga: { get: vi.fn(), approve: vi.fn(), execute: vi.fn() },
      readSource: vi.fn(),
      enqueueImport: vi.fn(),
      dependencies: {
        stageState: vi.fn(),
        trackRuns: vi.fn(),
        failState: vi.fn(),
      },
      registerAdapter: (kind) => adapters.push(kind),
      registerPreflight: (registered) => {
        hook(registered);
        return unregister;
      },
    });
    expect(adapters).toEqual(RECORD_ARTIFACT_IMPORT_ACTION_KINDS);
    expect(hook).toHaveBeenCalledOnce();
  });
});
