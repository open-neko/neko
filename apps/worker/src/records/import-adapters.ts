import type { Pool } from "pg";
import {
  buildRecordImportPlan,
  cancelRecordImportRun,
  createRecordImportRun,
  getRecordImportRun,
  RecordRegistry,
  verifyRecordImportPlanHash,
  type RecordImportPlan,
} from "@neko/records";
import {
  registerActionAdapter,
  registerActionRequestCreatedHook,
  RetryableActionAdapterError,
  updateActionRequestPayload,
  type ActionAdapter,
  type ActionRequestCreatedHook,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import type { RecordsImportPayload } from "@neko/db/jobs";

export const RECORD_IMPORT_ACTION_KINDS = [
  "records_import_start",
  "records_import_status",
  "records_import_cancel",
] as const;

export const RECORD_IMPORT_ACTION_DESCRIPTORS = [
  {
    kind: "records_import_start",
    scope: "internal",
    description:
      "Import a staged CSV into an existing generated-app object after reviewing its immutable column mapping, row count, samples, and duplicate key.",
    default_mode: "ask",
    example: {
      app: "equipment",
      object: "loan",
      source_path: "uploads/thread-id/loans.csv",
      mapping: { "Loan ID": "id", Asset: "name", Borrower: "borrower" },
      duplicate_key: "id",
    },
  },
  {
    kind: "records_import_status",
    scope: "internal",
    description: "Read the durable progress and reconciliation report for a records CSV import.",
    default_mode: { internal: "auto" },
    example: { import_run_id: "00000000-0000-4000-a000-000000000001" },
  },
  {
    kind: "records_import_cancel",
    scope: "internal",
    description:
      "Cancel a records CSV import at its next batch boundary; rows in committed batches remain imported and reported.",
    default_mode: "ask",
    example: { import_run_id: "00000000-0000-4000-a000-000000000001" },
  },
] as const;

export class RecordImportActionPayloadError extends Error {
  readonly code = "records_import_action_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordImportActionPayloadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new RecordImportActionPayloadError(`${field}: a non-empty string is required`);
  }
  return value.trim();
}

function optionalString(
  payload: Record<string, unknown>,
  field: string,
): string | undefined {
  if (payload[field] === undefined || payload[field] === null) return undefined;
  return requiredString(payload, field);
}

function assertOnlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new RecordImportActionPayloadError(
      `unknown payload field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`,
    );
  }
}

function stringMapping(value: unknown): Record<string, string | null> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new RecordImportActionPayloadError("mapping: an object is required");
  }
  const mapping: Record<string, string | null> = {};
  for (const [column, target] of Object.entries(value)) {
    if (!column.trim() || (target !== null && (typeof target !== "string" || !target.trim()))) {
      throw new RecordImportActionPayloadError(
        "mapping: every source column must map to a field name or null",
      );
    }
    mapping[column] = target === null ? null : target.trim();
  }
  return mapping;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new RecordImportActionPayloadError(`${field}: an array of non-empty strings is required`);
  }
  return value.map((item) => String(item).trim());
}

function optionalInteger(payload: Record<string, unknown>, field: string): number | undefined {
  if (payload[field] === undefined) return undefined;
  if (!Number.isSafeInteger(payload[field])) {
    throw new RecordImportActionPayloadError(`${field}: an integer is required`);
  }
  return Number(payload[field]);
}

function adminActor(request: ActionRequestRecord): string {
  if (request.actorRole !== "admin") {
    throw new RecordImportActionPayloadError("records imports require an admin actor snapshot");
  }
  return request.actorUserId?.trim() || `urn:openneko:solo-admin:${request.orgId}`;
}

function approvedPlan(request: ActionRequestRecord): RecordImportPlan {
  const raw = request.payload.import_plan;
  if (!isRecord(raw)) {
    throw new RecordImportActionPayloadError("records import is missing its approved plan");
  }
  const plan = raw as unknown as RecordImportPlan;
  verifyRecordImportPlanHash(plan);
  if (
    plan.appId !== request.payload.app ||
    plan.objectApiName !== request.payload.object ||
    plan.source.path !== request.payload.source_path
  ) {
    throw new RecordImportActionPayloadError("records import plan identity does not match its action");
  }
  return plan;
}

export function createRecordImportPreflightHook(input: {
  pool: Pool;
  readSource: (orgId: string, path: string) => Promise<Uint8Array>;
  updatePayload?: typeof updateActionRequestPayload;
  registry?: RecordRegistry;
}): ActionRequestCreatedHook {
  const registry = input.registry ?? new RecordRegistry(input.pool);
  const updatePayload = input.updatePayload ?? updateActionRequestPayload;
  return async (request) => {
    if (request.kind !== "records_import_start") return;
    adminActor(request);
    assertOnlyKeys(request.payload, [
      "app",
      "object",
      "source_path",
      "source_name",
      "mapping",
      "empty_text_columns",
      "duplicate_key",
      "batch_size",
      "owner_user_id",
    ]);
    const appId = requiredString(request.payload, "app");
    const objectApiName = requiredString(request.payload, "object");
    const sourcePath = requiredString(request.payload, "source_path");
    const snapshot = await registry.loadApp(request.orgId, appId);
    if (!snapshot) throw new RecordImportActionPayloadError("records import app is unknown");
    const bytes = await input.readSource(request.orgId, sourcePath);
    const sourceName =
      optionalString(request.payload, "source_name") ?? sourcePath.replaceAll("\\", "/").split("/").at(-1)!;
    const plan = buildRecordImportPlan({
      snapshot,
      objectApiName,
      sourcePath,
      sourceName,
      bytes,
      mapping: stringMapping(request.payload.mapping),
      emptyTextColumns: stringList(request.payload.empty_text_columns, "empty_text_columns"),
      duplicateKey: optionalString(request.payload, "duplicate_key"),
      batchSize: optionalInteger(request.payload, "batch_size"),
      ownerUserId: optionalString(request.payload, "owner_user_id") ?? null,
    });
    return updatePayload({
      id: request.id,
      orgId: request.orgId,
      payload: {
        app: plan.appId,
        object: plan.objectApiName,
        source_path: plan.source.path,
        source_name: plan.source.name,
        duplicate_key: plan.duplicateKey,
        batch_size: plan.batchSize,
        owner_user_id: plan.ownerUserId,
        mapping: Object.fromEntries(
          plan.columns.map((column) => [column.sourceColumn, column.targetField]),
        ),
        import_plan: plan,
      },
    });
  };
}

function importRunId(request: ActionRequestRecord): string {
  assertOnlyKeys(request.payload, ["import_run_id"]);
  const id = requiredString(request.payload, "import_run_id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new RecordImportActionPayloadError("import_run_id: a UUID is required");
  }
  return id;
}

function statusResult(run: NonNullable<Awaited<ReturnType<typeof getRecordImportRun>>>) {
  return {
    importRunId: run.id,
    appId: run.appId,
    objectApiName: run.plan.objectApiName,
    sourceName: run.plan.source.name,
    sourceRows: run.plan.rowCount,
    status: run.status,
    stage: run.currentStage,
    progress: run.progress,
    report: run.report,
    error: run.error,
    cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
  };
}

export function createRecordImportActionAdapter(
  kind: (typeof RECORD_IMPORT_ACTION_KINDS)[number],
  input: {
    pool: Pool;
    enqueueImport: (payload: RecordsImportPayload) => Promise<string | null>;
  },
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== kind) {
      throw new RecordImportActionPayloadError(
        `adapter ${kind} cannot execute action kind ${request.kind}`,
      );
    }
    const actorUserId = adminActor(request);
    if (kind === "records_import_start") {
      assertOnlyKeys(request.payload, [
        "app",
        "object",
        "source_path",
        "source_name",
        "duplicate_key",
        "batch_size",
        "owner_user_id",
        "mapping",
        "import_plan",
      ]);
      const plan = approvedPlan(request);
      const run = await createRecordImportRun(input.pool, {
        orgId: request.orgId,
        actionRequestId: request.id,
        plan,
      });
      let jobId: string | null;
      try {
        jobId = await input.enqueueImport({
          orgId: request.orgId,
          importRunId: run.id,
          actorUserId,
        });
      } catch (error) {
        throw new RetryableActionAdapterError(
          `records import ${run.id} could not be queued and will be retried`,
          { cause: error },
        );
      }
      if (!jobId) {
        throw new RetryableActionAdapterError(
          `records import ${run.id} could not be queued and will be retried`,
        );
      }
      return {
        commandOrOperation: kind,
        externalRef: run.id,
        result: { ...statusResult(run), jobId },
      };
    }

    const id = importRunId(request);
    const run =
      kind === "records_import_cancel"
        ? await cancelRecordImportRun(input.pool, { orgId: request.orgId, id })
        : await getRecordImportRun(input.pool, { orgId: request.orgId, id });
    if (!run) throw new RecordImportActionPayloadError("records import run was not found");
    return {
      commandOrOperation: kind,
      externalRef: run.id,
      result: statusResult(run),
    };
  };
}

export function registerRecordImportActions(input: {
  pool: Pool;
  readSource: (orgId: string, path: string) => Promise<Uint8Array>;
  enqueueImport: (payload: RecordsImportPayload) => Promise<string | null>;
  registerAdapter?: (kind: string, adapter: ActionAdapter) => void;
  registerPreflight?: (hook: ActionRequestCreatedHook) => () => void;
}): () => void {
  const registerAdapter = input.registerAdapter ?? registerActionAdapter;
  for (const kind of RECORD_IMPORT_ACTION_KINDS) {
    registerAdapter(kind, createRecordImportActionAdapter(kind, input));
  }
  return (input.registerPreflight ?? registerActionRequestCreatedHook)(
    createRecordImportPreflightHook(input),
  );
}
