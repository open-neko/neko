import type { Pool } from "pg";
import { and, db, eq, inArray, processing_job, sql } from "@neko/db";
import type {
  RecordsSalesforceCutoverPayload,
  RecordsSalesforceSyncPayload,
} from "@neko/db/jobs";
import { getActionRequest, type ActionRequestRecord } from "@neko/llm/workflows";
import {
  getRecordSyncCursor,
  RecordSyncCursorConflictError,
  RecordsActionLeaseBusyError,
  RecordsActionLeaseLostError,
  RecordsGraphjinRequestError,
  SalesforceApiError,
  type RecordWriteExecutor,
} from "@neko/records";
import {
  completeSalesforceCutover,
  getSalesforceSyncState,
  updateSalesforceCutoverState,
  type SalesforceSyncState,
} from "../records/salesforce-sync-state.js";
import {
  defaultRecordsSalesforceSyncDependencies,
  runRecordsSalesforceSync,
  withSalesforceSyncLock,
} from "./records-salesforce-sync.js";

const JOB_KIND = "records_salesforce_cutover";
const ACTION_KIND = "records_salesforce_cutover";
const SYNC_JOB_KIND = "records_salesforce_sync";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CutoverJob = {
  id: string;
  kind: string;
  status: string;
  triggerPayload: Record<string, unknown> | null;
};

type JobUpdate = {
  status?: string;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
};

export type RecordsSalesforceCutoverDependencies = {
  withAppLock: typeof withSalesforceSyncLock;
  getRequest: (orgId: string, id: string) => Promise<ActionRequestRecord | null>;
  getJob: (orgId: string, id: string, kind: string) => Promise<CutoverJob | null>;
  updateJob: (
    orgId: string,
    id: string,
    kind: string,
    update: JobUpdate,
    onlyStatuses?: string[],
  ) => Promise<boolean>;
  getState: typeof getSalesforceSyncState;
  updateCutover: typeof updateSalesforceCutoverState;
  createFinalSync: (
    state: SalesforceSyncState,
    cutoverJobId: string,
  ) => Promise<string>;
  runFinalSync: (
    writer: Pick<RecordWriteExecutor, "execute">,
    pool: Pool,
    payload: RecordsSalesforceSyncPayload,
  ) => Promise<void>;
  getCursor: typeof getRecordSyncCursor;
  completeCutover: typeof completeSalesforceCutover;
  now: () => Date;
};

function toJob(row: typeof processing_job.$inferSelect): CutoverJob {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    triggerPayload: (row.trigger_payload as Record<string, unknown> | null) ?? null,
  };
}

export const defaultRecordsSalesforceCutoverDependencies: RecordsSalesforceCutoverDependencies = {
  withAppLock: withSalesforceSyncLock,
  getRequest: getActionRequest,
  getJob: async (orgId, id, kind) => {
    const rows = await db()
      .select()
      .from(processing_job)
      .where(
        and(
          eq(processing_job.org_id, orgId),
          eq(processing_job.id, id),
          eq(processing_job.kind, kind),
        ),
      )
      .limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  },
  updateJob: async (orgId, id, kind, update, onlyStatuses) => {
    const values: Partial<typeof processing_job.$inferInsert> = { updated_at: new Date() };
    if (update.status !== undefined) values.status = update.status;
    if (update.progress !== undefined) values.progress = update.progress;
    if (update.result !== undefined) values.result = update.result;
    if (update.error !== undefined) values.error = update.error;
    if (update.startedAt !== undefined) values.started_at = update.startedAt;
    if (update.finishedAt !== undefined) values.finished_at = update.finishedAt;
    const filters = [
      eq(processing_job.org_id, orgId),
      eq(processing_job.id, id),
      eq(processing_job.kind, kind),
    ];
    if (onlyStatuses?.length) filters.push(inArray(processing_job.status, onlyStatuses));
    const rows = await db()
      .update(processing_job)
      .set(values)
      .where(and(...filters))
      .returning({ id: processing_job.id });
    return rows.length === 1;
  },
  getState: getSalesforceSyncState,
  updateCutover: updateSalesforceCutoverState,
  createFinalSync: async (state, cutoverJobId) =>
    db().transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${state.orgId}:${cutoverJobId}:final-sync`}, 0))`,
      );
      const existing = await transaction
        .select({ id: processing_job.id })
        .from(processing_job)
        .where(
          and(
            eq(processing_job.org_id, state.orgId),
            eq(processing_job.kind, SYNC_JOB_KIND),
            sql`${processing_job.trigger_payload}->>'cutover_job_id' = ${cutoverJobId}`,
            sql`${processing_job.trigger_payload}->>'final_delta' = 'true'`,
          ),
        )
        .limit(1);
      if (existing[0]) return existing[0].id;
      const [created] = await transaction
        .insert(processing_job)
        .values({
          org_id: state.orgId,
          kind: SYNC_JOB_KIND,
          status: "queued",
          trigger: "cutover",
          trigger_payload: {
            app_id: state.appId,
            source_instance_id: state.sourceInstanceId,
            cutover_job_id: cutoverJobId,
            final_delta: true,
          },
          progress: { stage: "queued", final_delta: true },
        })
        .returning({ id: processing_job.id });
      if (!created) throw new Error("final Salesforce delta job could not be created");
      return created.id;
    }),
  runFinalSync: (writer, pool, payload) =>
    runRecordsSalesforceSync(writer, pool, payload, {
      ...defaultRecordsSalesforceSyncDependencies,
      // The cutover worker already owns the same app-wide lock.
      withAppLock: async (_pool, _input, work) => work(),
    }),
  getCursor: getRecordSyncCursor,
  completeCutover: completeSalesforceCutover,
  now: () => new Date(),
};

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function retryable(error: unknown): boolean {
  if (error instanceof SalesforceApiError) return error.retryable;
  if (
    error instanceof RecordSyncCursorConflictError ||
    error instanceof RecordsActionLeaseBusyError ||
    error instanceof RecordsActionLeaseLostError
  ) {
    return true;
  }
  if (error instanceof RecordsGraphjinRequestError) {
    return error.status === null || error.status === 429 || error.status >= 500;
  }
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

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

function assertPayload(payload: RecordsSalesforceCutoverPayload): void {
  if (
    !UUID.test(payload.processingJobId) ||
    !payload.orgId.trim() ||
    !payload.appId.trim() ||
    !payload.sourceInstanceId.trim()
  ) {
    throw new Error("Salesforce cutover payload is invalid");
  }
}

function belongs(job: CutoverJob, payload: RecordsSalesforceCutoverPayload): boolean {
  return (
    job.kind === JOB_KIND &&
    job.triggerPayload?.app_id === payload.appId &&
    job.triggerPayload?.source_instance_id === payload.sourceInstanceId &&
    typeof job.triggerPayload.action_request_id === "string"
  );
}

export async function runRecordsSalesforceCutover(
  writer: Pick<RecordWriteExecutor, "execute">,
  pool: Pool,
  payload: RecordsSalesforceCutoverPayload,
  dependencies: RecordsSalesforceCutoverDependencies =
    defaultRecordsSalesforceCutoverDependencies,
): Promise<void> {
  assertPayload(payload);
  await dependencies.withAppLock(pool, payload, async () => {
    const [job, state] = await Promise.all([
      dependencies.getJob(payload.orgId, payload.processingJobId, JOB_KIND),
      dependencies.getState(payload.orgId, payload.appId),
    ]);
    if (!job || !belongs(job, payload)) {
      throw new Error("Salesforce cutover job does not belong to this app and source");
    }
    if (!state || state.sourceInstanceId !== payload.sourceInstanceId) {
      throw new Error("Salesforce cutover state was not found");
    }
    if (job.status === "succeeded" || job.status === "cancelled") return;
    if (
      state.mode === "primary" &&
      state.cutover?.processingJobId === job.id &&
      state.cutover.status === "succeeded"
    ) {
      await dependencies.updateJob(payload.orgId, job.id, JOB_KIND, {
        status: "succeeded",
        progress: { stage: "complete" },
        result: { app_id: state.appId, mode: "primary", recovered: true },
        error: null,
        finishedAt: dependencies.now(),
      });
      return;
    }
    if (
      state.mode !== "cutting_over" ||
      state.cutover?.processingJobId !== job.id ||
      state.cutover.actionRequestId !== job.triggerPayload?.action_request_id
    ) {
      throw new Error("Salesforce cutover checkpoint does not match this job");
    }
    const request = await dependencies.getRequest(
      payload.orgId,
      state.cutover.actionRequestId,
    );
    if (
      !request ||
      request.kind !== ACTION_KIND ||
      request.actorRole !== "admin" ||
      !["approved", "executed"].includes(request.status)
    ) {
      throw new Error("approved Salesforce cutover request was not found");
    }
    const claimed = await dependencies.updateJob(
      payload.orgId,
      job.id,
      JOB_KIND,
      {
        status: "running",
        progress: { stage: "freezing" },
        error: null,
        startedAt: dependencies.now(),
        finishedAt: null,
      },
      ["queued", "retrying", "failed", "running"],
    );
    if (!claimed) return;
    await dependencies.updateCutover(state, { status: "running", lastError: null });
    let promoted = false;
    try {
      const finalSyncJobId = await dependencies.createFinalSync(state, job.id);
      await dependencies.updateCutover(state, {
        status: "final_sync",
        finalSyncJobId,
        lastError: null,
      });
      await dependencies.updateJob(payload.orgId, job.id, JOB_KIND, {
        progress: { stage: "final_sync", final_sync_job_id: finalSyncJobId },
      });
      const syncPayload: RecordsSalesforceSyncPayload = {
        processingJobId: finalSyncJobId,
        orgId: state.orgId,
        appId: state.appId,
        sourceInstanceId: state.sourceInstanceId,
      };
      await dependencies.runFinalSync(writer, pool, syncPayload);
      const [finalJob, refreshed] = await Promise.all([
        dependencies.getJob(payload.orgId, finalSyncJobId, SYNC_JOB_KIND),
        dependencies.getState(payload.orgId, payload.appId),
      ]);
      if (!finalJob || finalJob.status !== "succeeded") {
        throw new Error(
          `final Salesforce delta did not succeed${finalJob?.status ? ` (${finalJob.status})` : ""}`,
        );
      }
      if (!refreshed || refreshed.mode !== "cutting_over") {
        throw new Error("Salesforce cutover mode changed before verification");
      }
      for (const object of refreshed.objects) {
        const cursor = await dependencies.getCursor(pool, {
          orgId: refreshed.orgId,
          appId: refreshed.appId,
          sourceInstanceId: refreshed.sourceInstanceId,
          objectApiName: object.objectApiName,
        });
        if (!cursor || canonical(cursor.watermark) !== canonical(object.watermark)) {
          throw new Error(`${object.objectApiName}: final Salesforce watermark was not verified`);
        }
      }
      const completedAt = dependencies.now();
      await dependencies.completeCutover(refreshed, completedAt.toISOString());
      promoted = true;
      const completed = await dependencies.updateJob(
        payload.orgId,
        job.id,
        JOB_KIND,
        {
          status: "succeeded",
          progress: { stage: "complete", objects: refreshed.objects.length },
          result: {
            app_id: refreshed.appId,
            source_instance_id: refreshed.sourceInstanceId,
            final_sync_job_id: finalSyncJobId,
            mode: "primary",
          },
          error: null,
          finishedAt: completedAt,
        },
        ["running"],
      );
      if (!completed) throw new RecordsActionLeaseLostError(job.id);
    } catch (error) {
      const failure = message(error);
      if (!promoted) {
        await dependencies.updateCutover(state, {
          status: retryable(error) ? "retrying" : "failed",
          lastError: failure,
          ...(!retryable(error)
            ? { completedAt: dependencies.now().toISOString() }
            : {}),
        });
      }
      if (retryable(error)) {
        await dependencies.updateJob(payload.orgId, job.id, JOB_KIND, {
          status: "retrying",
          progress: { stage: promoted ? "promoted" : "retrying" },
          error: failure,
        });
        throw error;
      }
      await dependencies.updateJob(payload.orgId, job.id, JOB_KIND, {
        status: "failed",
        progress: { stage: "failed" },
        error: failure,
        finishedAt: dependencies.now(),
      });
    }
  });
}
