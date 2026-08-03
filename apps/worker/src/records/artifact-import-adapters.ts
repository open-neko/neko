import type { Pool } from "pg";
import type { RecordsImportPayload } from "@neko/db/jobs";
import {
  buildRecordArtifactImportPlan,
  createRecordImportRun,
  recordAppDefinitionPayload,
  RecordsSchemaApprovalStaleError,
  verifyRecordArtifactImportPlan,
  type RecordArtifactImportPlan,
  type RecordSchemaChange,
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
import {
  failArtifactImportState,
  stageArtifactImportState,
  trackArtifactImportRuns,
} from "./artifact-import-state.js";

export const RECORD_ARTIFACT_IMPORT_ACTION_KINDS = [
  "records_artifact_import_start",
  "records_artifact_import_from_export",
] as const;

export type RecordArtifactImportActionKind =
  (typeof RECORD_ARTIFACT_IMPORT_ACTION_KINDS)[number];

export const RECORD_ARTIFACT_IMPORT_ACTION_DESCRIPTORS = [
  {
    kind: "records_artifact_import_start",
    scope: "internal",
    description:
      "Verify a staged connector artifact, review its complete generated schema and mappings, then create and load the app through durable per-object imports.",
    default_mode: "ask",
    example: {
      artifact_path: "imports/salesforce/export-job-id",
      app: "crm",
      label: "CRM",
      batch_size: 100,
    },
  },
] as const;

export class RecordArtifactImportActionPayloadError extends Error {
  readonly code = "records_artifact_import_action_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordArtifactImportActionPayloadError";
  }
}

export type RecordArtifactSchemaPlanner = {
  prepare(input: {
    id: string;
    orgId: string;
    kind: string;
    payload: Record<string, unknown>;
    actorUserId: string | null;
    actorRole: string | null;
  }): Promise<{ payload: Record<string, unknown> }>;
};

export type RecordArtifactSchemaSaga = {
  get(actionRequestId: string): Promise<RecordSchemaChange | null>;
  approve(actionRequestId: string, previewHash: string): Promise<RecordSchemaChange>;
  execute(actionRequestId: string): Promise<RecordSchemaChange>;
};

export type RecordArtifactImportActionDependencies = {
  pool: Pool;
  saga: RecordArtifactSchemaSaga;
  enqueueImport: (payload: RecordsImportPayload) => Promise<string | null>;
  stageState: typeof stageArtifactImportState;
  trackRuns: typeof trackArtifactImportRuns;
  failState: typeof failArtifactImportState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_000) {
    throw new RecordArtifactImportActionPayloadError(
      `${field}: a non-empty string is required`,
    );
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

function optionalInteger(
  payload: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = payload[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 500) {
    throw new RecordArtifactImportActionPayloadError(
      `${field}: an integer between 1 and 500 is required`,
    );
  }
  return Number(value);
}

function requiredHash(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RecordArtifactImportActionPayloadError(
      `${field}: a lowercase SHA-256 hash is required`,
    );
  }
  return value;
}

function assertOnlyKeys(payload: Record<string, unknown>, allowed: string[]): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new RecordArtifactImportActionPayloadError(
      `unknown payload field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`,
    );
  }
}

function assertActor(
  kind: RecordArtifactImportActionKind,
  request: ActionRequestRecord,
): string {
  if (request.actorRole !== "admin") {
    throw new RecordArtifactImportActionPayloadError(
      "connector artifact imports require an admin actor snapshot",
    );
  }
  if (
    kind === "records_artifact_import_from_export" &&
    request.actorBackend !== "records-salesforce-export"
  ) {
    throw new RecordArtifactImportActionPayloadError(
      "automatic artifact import requires the trusted Salesforce export worker",
    );
  }
  return request.actorUserId?.trim() || `urn:openneko:solo-admin:${request.orgId}`;
}

function approvedPlan(request: ActionRequestRecord): RecordArtifactImportPlan {
  const raw = request.payload.artifact_import_plan;
  if (!isRecord(raw)) {
    throw new RecordArtifactImportActionPayloadError(
      "artifact import is missing its approved plan",
    );
  }
  const plan = raw as unknown as RecordArtifactImportPlan;
  verifyRecordArtifactImportPlan(plan);
  if (
    plan.directory !== request.payload.artifact_path ||
    plan.definition.appId !== request.payload.app
  ) {
    throw new RecordArtifactImportActionPayloadError(
      "artifact import plan identity does not match its action",
    );
  }
  if (request.kind === "records_artifact_import_from_export") {
    requiredString(request.payload, "export_action_request_id");
    if (
      plan.manifest.source.instanceId !==
        requiredString(request.payload, "source_instance_id") ||
      plan.sourceSchemaHash !== requiredHash(request.payload, "approved_schema_hash")
    ) {
      throw new RecordsSchemaApprovalStaleError(
        "Salesforce artifact schema no longer matches the approved export",
      );
    }
  }
  return plan;
}

function previewHash(request: ActionRequestRecord): string {
  const value = request.payload.preview_hash;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RecordArtifactImportActionPayloadError(
      "artifact import is missing its approved schema hash",
    );
  }
  return value;
}

const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "53300",
  "53400",
  "55P03",
  "57P01",
  "57P02",
  "57P03",
]);

function retryable(error: unknown): boolean {
  if (error instanceof RetryableActionAdapterError) return true;
  if (error instanceof RecordsSchemaApprovalStaleError) return false;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return code.startsWith("08") || TRANSIENT_CODES.has(code);
}

export function createRecordArtifactImportPreflightHook(input: {
  planner: RecordArtifactSchemaPlanner;
  readSource: (orgId: string, path: string) => Promise<Uint8Array>;
  updatePayload?: typeof updateActionRequestPayload;
}): ActionRequestCreatedHook {
  const updatePayload = input.updatePayload ?? updateActionRequestPayload;
  return async (request) => {
    if (!RECORD_ARTIFACT_IMPORT_ACTION_KINDS.includes(request.kind as never)) return;
    const kind = request.kind as RecordArtifactImportActionKind;
    assertActor(kind, request);
    assertOnlyKeys(request.payload, [
      "artifact_path",
      "app",
      "label",
      "purpose",
      "batch_size",
      "owner_user_id",
      ...(kind === "records_artifact_import_from_export"
        ? [
            "export_job_id",
            "export_action_request_id",
            "source_instance_id",
            "approved_schema_hash",
          ]
        : []),
    ]);
    const artifactPath = requiredString(request.payload, "artifact_path");
    const plan = await buildRecordArtifactImportPlan({
      directory: artifactPath,
      app: requiredString(request.payload, "app"),
      label: requiredString(request.payload, "label"),
      purpose: optionalString(request.payload, "purpose"),
      batchSize: optionalInteger(request.payload, "batch_size"),
      ownerUserId: optionalString(request.payload, "owner_user_id"),
      readFile: (path) => input.readSource(request.orgId, path),
    });
    if (kind === "records_artifact_import_from_export") {
      requiredString(request.payload, "export_action_request_id");
      const sourceInstanceId = requiredString(request.payload, "source_instance_id");
      const approvedSchemaHash = requiredHash(
        request.payload,
        "approved_schema_hash",
      );
      if (
        plan.manifest.source.instanceId !== sourceInstanceId ||
        plan.sourceSchemaHash !== approvedSchemaHash
      ) {
        throw new RecordsSchemaApprovalStaleError(
          "Salesforce artifact schema does not match the reviewed export plan",
        );
      }
    }
    const prepared = await input.planner.prepare({
      id: request.id,
      orgId: request.orgId,
      kind: "app_create",
      payload: recordAppDefinitionPayload(plan.definition),
      actorUserId: request.actorUserId,
      actorRole: request.actorRole,
    });
    return updatePayload({
      id: request.id,
      orgId: request.orgId,
      payload: {
        artifact_path: plan.directory,
        app: plan.definition.appId,
        label: plan.definition.label,
        purpose: plan.definition.purpose,
        batch_size: plan.imports[0]?.batchSize ?? 100,
        owner_user_id: plan.imports[0]?.ownerUserId ?? null,
        ...(kind === "records_artifact_import_from_export"
          ? {
              export_job_id: request.payload.export_job_id,
              export_action_request_id: request.payload.export_action_request_id,
              source_instance_id: request.payload.source_instance_id,
              approved_schema_hash: request.payload.approved_schema_hash,
            }
          : {}),
        artifact_import_plan: plan,
        preview_hash: prepared.payload.preview_hash,
        schema_preview: prepared.payload.schema_preview,
      },
    });
  };
}

function childActionRequestId(parentId: string, objectApiName: string): string {
  return `${parentId}:artifact:${objectApiName}`;
}

export function createRecordArtifactImportActionAdapter(
  kind: RecordArtifactImportActionKind,
  dependencies: RecordArtifactImportActionDependencies,
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== kind) {
      throw new RecordArtifactImportActionPayloadError(
        `artifact adapter ${kind} cannot execute action kind ${request.kind}`,
      );
    }
    const actorUserId = assertActor(kind, request);
    assertOnlyKeys(request.payload, [
      "artifact_path",
      "app",
      "label",
      "purpose",
      "batch_size",
      "owner_user_id",
      "artifact_import_plan",
      "preview_hash",
      "schema_preview",
      ...(kind === "records_artifact_import_from_export"
        ? [
            "export_job_id",
            "export_action_request_id",
            "source_instance_id",
            "approved_schema_hash",
          ]
        : []),
    ]);
    const plan = approvedPlan(request);
    try {
      await dependencies.stageState(request, plan);
      const hash = previewHash(request);
      let change = await dependencies.saga.get(request.id);
      if (!change || change.previewHash !== hash) {
        throw new RecordsSchemaApprovalStaleError(
          "artifact import approval does not match its schema plan",
        );
      }
      if (change.phase === "planned") {
        change = await dependencies.saga.approve(request.id, hash);
      }
      if (!["approved", "applying", "applied", "projected"].includes(change.phase)) {
        throw new Error(`artifact schema change cannot resume from ${change.phase}`);
      }
      change = await dependencies.saga.execute(request.id);
      if (change.phase !== "projected") {
        throw new Error("artifact schema projection did not complete");
      }

      const runs = [];
      for (const objectPlan of plan.imports) {
        runs.push(
          await createRecordImportRun(dependencies.pool, {
            orgId: request.orgId,
            actionRequestId: childActionRequestId(request.id, objectPlan.objectApiName),
            sourceInstanceId: plan.manifest.source.instanceId,
            plan: objectPlan,
          }),
        );
      }
      await dependencies.trackRuns(
        request,
        plan,
        runs.map((run) => run.id),
      );
      const jobs = [];
      for (const run of runs) {
        try {
          const jobId = await dependencies.enqueueImport({
            orgId: request.orgId,
            importRunId: run.id,
            actorUserId,
          });
          jobs.push({ importRunId: run.id, objectApiName: run.plan.objectApiName, jobId });
        } catch (error) {
          throw new RetryableActionAdapterError(
            `artifact import ${run.id} could not be queued and will be retried`,
            { cause: error },
          );
        }
      }
      return {
        commandOrOperation: kind,
        externalRef: request.id,
        result: {
          appId: plan.definition.appId,
          sourceInstanceId: plan.manifest.source.instanceId,
          mode: plan.manifest.source.mode,
          manifestHash: plan.manifest.manifestHash,
          schemaPhase: change.phase,
          jobs,
        },
      };
    } catch (error) {
      if (retryable(error)) {
        if (error instanceof RetryableActionAdapterError) throw error;
        throw new RetryableActionAdapterError(
          `artifact import ${request.id} is temporarily unavailable and will be retried`,
          { cause: error },
        );
      }
      await dependencies.failState(request, plan, error).catch(() => undefined);
      throw error;
    }
  };
}

export function registerRecordArtifactImportActions(input: {
  pool: Pool;
  planner: RecordArtifactSchemaPlanner;
  saga: RecordArtifactSchemaSaga;
  readSource: (orgId: string, path: string) => Promise<Uint8Array>;
  enqueueImport: (payload: RecordsImportPayload) => Promise<string | null>;
  dependencies?: Partial<
    Pick<RecordArtifactImportActionDependencies, "stageState" | "trackRuns" | "failState">
  >;
  registerAdapter?: (kind: string, adapter: ActionAdapter) => void;
  registerPreflight?: (hook: ActionRequestCreatedHook) => () => void;
}): () => void {
  const dependencies: RecordArtifactImportActionDependencies = {
    pool: input.pool,
    saga: input.saga,
    enqueueImport: input.enqueueImport,
    stageState: input.dependencies?.stageState ?? stageArtifactImportState,
    trackRuns: input.dependencies?.trackRuns ?? trackArtifactImportRuns,
    failState: input.dependencies?.failState ?? failArtifactImportState,
  };
  const register = input.registerAdapter ?? registerActionAdapter;
  for (const kind of RECORD_ARTIFACT_IMPORT_ACTION_KINDS) {
    register(kind, createRecordArtifactImportActionAdapter(kind, dependencies));
  }
  return (input.registerPreflight ?? registerActionRequestCreatedHook)(
    createRecordArtifactImportPreflightHook({
      planner: input.planner,
      readSource: input.readSource,
    }),
  );
}
