import { resolve } from "node:path";
import {
  and,
  action_request,
  db,
  eq,
  inArray,
  processing_job,
  sql,
} from "@neko/db";
import {
  enqueue,
  QUEUE,
  type RecordsSalesforceExportPayload,
} from "@neko/db/jobs";
import { ensureOrgWorkspace } from "@neko/llm/work";
import { inProcessControlPlane } from "@neko/llm/work";
import {
  getActionRequest,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  assertSalesforceSchemaMatchesReview,
  SalesforceApiError,
  type RecordConnectorExportResult,
  type SalesforceConnector,
} from "@neko/records";
import {
  createSalesforceConnectorForAction,
  parseApprovedSalesforceSchemaReview,
  parseSalesforceActionConfig,
} from "../records/salesforce-runtime.js";

const EXPORT_KIND = "records_salesforce_export";
const ACTION_KIND = "records_salesforce_export_start";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SalesforceExportJobRecord = {
  id: string;
  orgId: string;
  kind: string;
  status: string;
  trigger: string;
  triggerPayload: Record<string, unknown> | null;
};

type SalesforceExportJobUpdate = {
  status?: string;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
};

export type RecordsSalesforceExportDependencies = {
  getRequest: (orgId: string, id: string) => Promise<ActionRequestRecord | null>;
  getJob: (orgId: string, id: string) => Promise<SalesforceExportJobRecord | null>;
  updateJob: (
    orgId: string,
    id: string,
    update: SalesforceExportJobUpdate,
    onlyStatuses?: string[],
  ) => Promise<boolean>;
  connectorForAction: (
    request: ActionRequestRecord,
  ) => Promise<Pick<SalesforceConnector, "export" | "schemaPlan">>;
  workspaceForOrg: (orgId: string) => Promise<{ orgRoot: string }>;
  cancellationPollMs: number;
  scheduleImport: (
    request: ActionRequestRecord,
    payload: RecordsSalesforceExportPayload,
    artifactPath: string,
  ) => Promise<string>;
};

/** Idempotently chain a completed approved export into its trusted artifact import. */
export async function scheduleSalesforceArtifactImport(
  request: ActionRequestRecord,
  payload: RecordsSalesforceExportPayload,
  artifactPath: string,
): Promise<string> {
  const target = `salesforce-export:${payload.exportJobId}`;
  const decision = await inProcessControlPlane.evaluateActionPolicy({
    orgId: payload.orgId,
    scope: "internal",
    kind: "records_artifact_import_from_export",
    target,
    riskLevel: "high",
  });
  if (decision.decision !== "allow") {
    throw new Error("Salesforce artifact import is not allowed by policy");
  }
  const chained = await db().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${payload.orgId}:${target}`}, 0))`,
    );
    const existing = await transaction
      .select({ id: action_request.id, status: action_request.status })
      .from(action_request)
      .where(
        and(
          eq(action_request.org_id, payload.orgId),
          eq(action_request.kind, "records_artifact_import_from_export"),
          eq(action_request.target, target),
        ),
      )
      .orderBy(sql`${action_request.created_at} desc`)
      .limit(1);
    if (existing[0] && existing[0].status !== "failed") return existing[0];
    const config = parseSalesforceActionConfig(request.payload);
    const review = parseApprovedSalesforceSchemaReview(request.payload);
    const summary = `Create ${config.label} from verified Salesforce export ${payload.exportJobId}`;
    const created = await inProcessControlPlane.createActionRequest({
      orgId: payload.orgId,
      scope: "internal",
      kind: "records_artifact_import_from_export",
      target,
      payload: {
        artifact_path: artifactPath,
        app: config.app,
        label: config.label,
        export_job_id: payload.exportJobId,
        export_action_request_id: request.id,
        source_instance_id: review.sourceInstanceId,
        approved_schema_hash: review.planHash,
      },
      riskLevel: "high",
      status: "approved",
      policyId: decision.policy.id,
      summary,
      intent: `${summary}; this load is the second half of the already-approved export.`,
      actorUserId: request.actorUserId,
      actorRole: "admin",
      actorBackend: "records-salesforce-export",
    });
    return { id: created.id, status: "approved" };
  });
  if (chained.status === "approved") {
    await enqueue(
      QUEUE.ACTION_EXECUTE,
      { orgId: payload.orgId, actionRequestId: chained.id },
      { singletonKey: `records-artifact-import:${chained.id}` },
    );
  }
  return chained.id;
}

function toJob(row: typeof processing_job.$inferSelect): SalesforceExportJobRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    status: row.status,
    trigger: row.trigger,
    triggerPayload: (row.trigger_payload as Record<string, unknown> | null) ?? null,
  };
}

export const defaultRecordsSalesforceExportDependencies: RecordsSalesforceExportDependencies = {
  getRequest: getActionRequest,
  getJob: async (orgId, id) => {
    const rows = await db()
      .select()
      .from(processing_job)
      .where(and(eq(processing_job.org_id, orgId), eq(processing_job.id, id)))
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  },
  updateJob: async (orgId, id, update, onlyStatuses) => {
    const values: Partial<typeof processing_job.$inferInsert> = {
      updated_at: new Date(),
    };
    if (update.status !== undefined) values.status = update.status;
    if (update.progress !== undefined) values.progress = update.progress;
    if (update.result !== undefined) values.result = update.result;
    if (update.error !== undefined) values.error = update.error;
    if (update.startedAt !== undefined) values.started_at = update.startedAt;
    if (update.finishedAt !== undefined) values.finished_at = update.finishedAt;
    const filters = [
      eq(processing_job.org_id, orgId),
      eq(processing_job.id, id),
      eq(processing_job.kind, EXPORT_KIND),
    ];
    if (onlyStatuses && onlyStatuses.length > 0) {
      filters.push(inArray(processing_job.status, onlyStatuses));
    }
    const rows = await db()
      .update(processing_job)
      .set(values)
      .where(and(...filters))
      .returning({ id: processing_job.id });
    return rows.length === 1;
  },
  connectorForAction: createSalesforceConnectorForAction,
  workspaceForOrg: ensureOrgWorkspace,
  cancellationPollMs: 750,
  scheduleImport: scheduleSalesforceArtifactImport,
};

function assertPayload(payload: RecordsSalesforceExportPayload): void {
  if (!payload.orgId.trim()) throw new Error("Salesforce export organization is required");
  if (!UUID.test(payload.actionRequestId)) {
    throw new Error("Salesforce export action request id is invalid");
  }
  if (!UUID.test(payload.exportJobId) || payload.processingJobId !== payload.exportJobId) {
    throw new Error("Salesforce export processing job id is invalid");
  }
}

function triggerMatches(job: SalesforceExportJobRecord, actionRequestId: string): boolean {
  return (
    job.kind === EXPORT_KIND &&
    job.trigger === "action_request" &&
    job.triggerPayload?.action_request_id === actionRequestId
  );
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function retryable(error: unknown): boolean {
  if (error instanceof SalesforceApiError) return error.retryable;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return (
    code.startsWith("08") ||
    ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "57P02", "57P03"].includes(
      code,
    )
  );
}

function exportResult(result: RecordConnectorExportResult, relativeDirectory: string) {
  return {
    artifact_path: relativeDirectory,
    manifest: result.manifest,
  };
}

async function markCancelled(
  dependencies: RecordsSalesforceExportDependencies,
  payload: RecordsSalesforceExportPayload,
): Promise<void> {
  await dependencies.updateJob(payload.orgId, payload.exportJobId, {
    status: "cancelled",
    progress: { stage: "cancelled" },
    error: null,
    finishedAt: new Date(),
  });
}

/**
 * Runs an approved Salesforce export using only the snapshotted action payload.
 * Secrets are resolved inside connectorForAction and are never copied into the
 * queue, processing_job progress, or the staged artifact manifest.
 */
export async function runRecordsSalesforceExport(
  payload: RecordsSalesforceExportPayload,
  dependencies: RecordsSalesforceExportDependencies =
    defaultRecordsSalesforceExportDependencies,
): Promise<void> {
  assertPayload(payload);
  const [request, initialJob] = await Promise.all([
    dependencies.getRequest(payload.orgId, payload.actionRequestId),
    dependencies.getJob(payload.orgId, payload.exportJobId),
  ]);
  if (
    !request ||
    request.kind !== ACTION_KIND ||
    request.actorRole !== "admin" ||
    !["approved", "executed"].includes(request.status)
  ) {
    throw new Error("Salesforce export action request was not found");
  }
  if (!initialJob || !triggerMatches(initialJob, request.id)) {
    throw new Error("Salesforce export job does not belong to the action request");
  }
  if (initialJob.status === "succeeded" || initialJob.status === "cancelled") return;
  if (initialJob.status === "cancel_requested") {
    await markCancelled(dependencies, payload);
    return;
  }

  const claimed = await dependencies.updateJob(
    payload.orgId,
    payload.exportJobId,
    {
      status: "running",
      progress: { stage: "exporting", resume: initialJob.status !== "queued" },
      error: null,
      startedAt: new Date(),
      finishedAt: null,
    },
    ["queued", "retrying", "failed", "running"],
  );
  if (!claimed) {
    const current = await dependencies.getJob(payload.orgId, payload.exportJobId);
    if (current?.status === "cancel_requested") await markCancelled(dependencies, payload);
    return;
  }

  const workspace = await dependencies.workspaceForOrg(payload.orgId);
  const relativeDirectory = `imports/salesforce/${payload.exportJobId}`;
  const directory = resolve(workspace.orgRoot, relativeDirectory);
  const controller = new AbortController();
  let cancellationCheckError: unknown = null;
  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    dependencies
      .getJob(payload.orgId, payload.exportJobId)
      .then((job) => {
        if (!job || job.status === "cancel_requested") controller.abort();
      })
      .catch((error: unknown) => {
        cancellationCheckError = error;
        controller.abort();
      })
      .finally(() => {
        checking = false;
      });
  }, dependencies.cancellationPollMs);
  timer.unref?.();

  try {
    const connector = await dependencies.connectorForAction(request);
    const review = parseApprovedSalesforceSchemaReview(request.payload);
    assertSalesforceSchemaMatchesReview(
      await connector.schemaPlan(controller.signal),
      review,
    );
    const result = await connector.export({
      directory,
      resume: true,
      signal: controller.signal,
    });
    const artifactImportActionId = await dependencies.scheduleImport(
      request,
      payload,
      relativeDirectory,
    );
    const current = await dependencies.getJob(payload.orgId, payload.exportJobId);
    if (current?.status === "cancel_requested") {
      await markCancelled(dependencies, payload);
      return;
    }
    const completed = await dependencies.updateJob(
      payload.orgId,
      payload.exportJobId,
      {
        status: "succeeded",
        progress: {
          stage: "complete",
          objects: result.manifest.objects.length,
          rows: result.manifest.objects.reduce((sum, object) => sum + object.expectedRows, 0),
        },
        result: {
          ...exportResult(result, relativeDirectory),
          artifact_import_action_id: artifactImportActionId,
        },
        error: null,
        finishedAt: new Date(),
      },
      ["running"],
    );
    if (!completed) {
      const latest = await dependencies.getJob(payload.orgId, payload.exportJobId);
      if (latest?.status === "cancel_requested") {
        await markCancelled(dependencies, payload);
        return;
      }
      throw new Error("Salesforce export lost its processing job lease");
    }
  } catch (error) {
    const current = await dependencies.getJob(payload.orgId, payload.exportJobId);
    if (current?.status === "cancel_requested" && !cancellationCheckError) {
      await markCancelled(dependencies, payload);
      return;
    }
    const failure = cancellationCheckError ?? error;
    if (retryable(failure)) {
      await dependencies.updateJob(payload.orgId, payload.exportJobId, {
        status: "retrying",
        progress: { stage: "retrying", resume: true },
        error: message(failure),
      });
      throw failure;
    }
    await dependencies.updateJob(payload.orgId, payload.exportJobId, {
      status: "failed",
      progress: { stage: "failed", resume: true },
      error: message(failure),
      finishedAt: new Date(),
    });
  } finally {
    clearInterval(timer);
  }
}
