import type { Pool } from "pg";
import {
  and,
  db,
  eq,
  inArray,
  processing_job,
} from "@neko/db";
import type { RecordsSalesforceSyncPayload } from "@neko/db/jobs";
import {
  getActionRequest,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  applyRecordConnectorDelta,
  getRecordSyncCursor,
  RecordSyncCursorConflictError,
  RecordsActionLeaseBusyError,
  RecordsActionLeaseLostError,
  RecordsGraphjinRequestError,
  SalesforceApiError,
  type RecordWriteExecutor,
  type SalesforceConnector,
} from "@neko/records";
import {
  createSalesforceConnectorForAction,
  parseApprovedSalesforceSchemaReview,
} from "../records/salesforce-runtime.js";
import {
  getSalesforceSyncState,
  mirrorSalesforceSyncWatermarks,
  updateSalesforceSyncState,
  type SalesforceSyncState,
} from "../records/salesforce-sync-state.js";

const JOB_KIND = "records_salesforce_sync";
const EXPORT_ACTION_KIND = "records_salesforce_export_start";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SalesforceSyncJobRecord = {
  id: string;
  orgId: string;
  kind: string;
  status: string;
  triggerPayload: Record<string, unknown> | null;
};

type SalesforceSyncJobUpdate = {
  status?: string;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date | null;
};

export type RecordsSalesforceSyncDependencies = {
  withAppLock: <T>(
    pool: Pool,
    input: Pick<RecordsSalesforceSyncPayload, "orgId" | "appId" | "sourceInstanceId">,
    work: () => Promise<T>,
  ) => Promise<T>;
  getRequest: (orgId: string, id: string) => Promise<ActionRequestRecord | null>;
  getJob: (orgId: string, id: string) => Promise<SalesforceSyncJobRecord | null>;
  updateJob: (
    orgId: string,
    id: string,
    update: SalesforceSyncJobUpdate,
    onlyStatuses?: string[],
  ) => Promise<boolean>;
  getState: (orgId: string, appId: string) => Promise<SalesforceSyncState | null>;
  updateState: typeof updateSalesforceSyncState;
  connectorForAction: (
    request: ActionRequestRecord,
  ) => Promise<
    Pick<SalesforceConnector, "delta" | "budgetSnapshot" | "restoreBudget">
  >;
  getCursor: typeof getRecordSyncCursor;
  applyDelta: typeof applyRecordConnectorDelta;
  mirrorWatermarks: typeof mirrorSalesforceSyncWatermarks;
  now: () => Date;
};

function toJob(row: typeof processing_job.$inferSelect): SalesforceSyncJobRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    status: row.status,
    triggerPayload: (row.trigger_payload as Record<string, unknown> | null) ?? null,
  };
}

export const defaultRecordsSalesforceSyncDependencies: RecordsSalesforceSyncDependencies = {
  withAppLock: withSalesforceSyncLock,
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
      eq(processing_job.kind, JOB_KIND),
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
  updateState: updateSalesforceSyncState,
  connectorForAction: createSalesforceConnectorForAction,
  getCursor: getRecordSyncCursor,
  applyDelta: applyRecordConnectorDelta,
  mirrorWatermarks: mirrorSalesforceSyncWatermarks,
  now: () => new Date(),
};

export async function withSalesforceSyncLock<T>(
  pool: Pool,
  input: Pick<RecordsSalesforceSyncPayload, "orgId" | "appId" | "sourceInstanceId">,
  work: () => Promise<T>,
): Promise<T> {
  const identity = `records-salesforce-sync:${input.orgId}:${input.appId}:${input.sourceInstanceId}`;
  const client = await pool.connect();
  await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [identity]);
  try {
    return await work();
  } finally {
    await client
      .query("select pg_advisory_unlock(hashtextextended($1, 0))", [identity])
      .finally(() => client.release());
  }
}

function assertPayload(payload: RecordsSalesforceSyncPayload): void {
  if (
    !UUID.test(payload.processingJobId) ||
    !payload.orgId.trim() ||
    !payload.appId.trim() ||
    !payload.sourceInstanceId.trim()
  ) {
    throw new Error("Salesforce sync payload is invalid");
  }
}

function belongsToPayload(
  job: SalesforceSyncJobRecord,
  payload: RecordsSalesforceSyncPayload,
): boolean {
  return (
    job.kind === JOB_KIND &&
    job.triggerPayload?.app_id === payload.appId &&
    job.triggerPayload?.source_instance_id === payload.sourceInstanceId
  );
}

function finalCutoverJobId(job: SalesforceSyncJobRecord): string | null {
  return job.triggerPayload?.final_delta === true &&
    typeof job.triggerPayload.cutover_job_id === "string"
    ? job.triggerPayload.cutover_job_id
    : null;
}

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

export async function runRecordsSalesforceSync(
  writer: Pick<RecordWriteExecutor, "execute">,
  pool: Pool,
  payload: RecordsSalesforceSyncPayload,
  dependencies: RecordsSalesforceSyncDependencies =
    defaultRecordsSalesforceSyncDependencies,
): Promise<void> {
  assertPayload(payload);
  await dependencies.withAppLock(pool, payload, () =>
    runRecordsSalesforceSyncLocked(writer, pool, payload, dependencies),
  );
}

async function runRecordsSalesforceSyncLocked(
  writer: Pick<RecordWriteExecutor, "execute">,
  pool: Pool,
  payload: RecordsSalesforceSyncPayload,
  dependencies: RecordsSalesforceSyncDependencies,
): Promise<void> {
  const [initialJob, state] = await Promise.all([
    dependencies.getJob(payload.orgId, payload.processingJobId),
    dependencies.getState(payload.orgId, payload.appId),
  ]);
  if (!initialJob || !belongsToPayload(initialJob, payload)) {
    throw new Error("Salesforce sync job does not belong to this app and source");
  }
  if (!state || state.sourceInstanceId !== payload.sourceInstanceId) {
    throw new Error("Salesforce sync state was not found");
  }
  if (initialJob.status === "succeeded" || initialJob.status === "cancelled") return;
  const cutoverJobId = finalCutoverJobId(initialJob);
  if (
    cutoverJobId &&
    (state.mode !== "cutting_over" ||
      state.cutover?.processingJobId !== cutoverJobId ||
      state.cutover.status === "succeeded")
  ) {
    throw new Error("final Salesforce delta does not belong to the active cutover");
  }
  if (
    (!state.enabled && !cutoverJobId) ||
    state.mode === "primary" ||
    state.appStatus !== "active"
  ) {
    await dependencies.updateJob(payload.orgId, payload.processingJobId, {
      status: "cancelled",
      progress: { stage: "disabled" },
      result: { skipped: true, mode: state.mode },
      error: null,
      finishedAt: dependencies.now(),
    });
    return;
  }
  const claimed = await dependencies.updateJob(
    payload.orgId,
    payload.processingJobId,
    {
      status: "running",
      progress: { stage: "loading", objects: state.objects.length },
      error: null,
      startedAt: dependencies.now(),
      finishedAt: null,
    },
    ["queued", "retrying", "failed", "running"],
  );
  if (!claimed) return;
  await dependencies.updateState(state, {
    status: "running",
    lastStartedAt: dependencies.now().toISOString(),
    lastError: null,
  });

  let connector: Pick<
    SalesforceConnector,
    "delta" | "budgetSnapshot" | "restoreBudget"
  > | null = null;
  try {
    const request = await dependencies.getRequest(
      payload.orgId,
      state.exportActionRequestId,
    );
    if (
      !request ||
      request.kind !== EXPORT_ACTION_KIND ||
      request.actorRole !== "admin" ||
      !["approved", "executed"].includes(request.status)
    ) {
      throw new Error("approved Salesforce export configuration was not found");
    }
    const review = parseApprovedSalesforceSchemaReview(request.payload);
    if (
      review.sourceInstanceId !== state.sourceInstanceId ||
      review.plan.definition.appId !== state.appId
    ) {
      throw new Error("Salesforce sync configuration no longer matches the imported app");
    }
    connector = await dependencies.connectorForAction(request);
    connector.restoreBudget(state.apiBudget);
    const reports = [];
    for (const [index, object] of state.objects.entries()) {
      const cursor = await dependencies.getCursor(pool, {
        orgId: payload.orgId,
        appId: state.appId,
        sourceInstanceId: state.sourceInstanceId,
        objectApiName: object.objectApiName,
      });
      if (!cursor) throw new Error(`${object.objectApiName}: sync cursor was not seeded`);
      const mapping = review.plan.mappings.find(
        (candidate) =>
          candidate.sourceObject === object.sourceApiName &&
          candidate.targetObject === object.objectApiName,
      );
      if (!mapping) throw new Error(`${object.sourceApiName}: approved mapping is missing`);
      const delta = await connector.delta({
        sourceApiName: object.sourceApiName,
        watermark: cursor.watermark,
      });
      reports.push(
        await dependencies.applyDelta({
          pool,
          writer: writer as Pick<RecordWriteExecutor, "execute">,
          orgId: payload.orgId,
          appId: state.appId,
          sourceInstanceId: state.sourceInstanceId,
          objectApiName: object.objectApiName,
          expectedWatermark: cursor.watermark,
          delta,
          mapping,
        }),
      );
      await dependencies.updateJob(payload.orgId, payload.processingJobId, {
        progress: {
          stage: "syncing",
          object: object.objectApiName,
          completed: index + 1,
          total: state.objects.length,
        },
      });
    }
    const completedAt = dependencies.now();
    await dependencies.mirrorWatermarks(
      state,
      reports.map((report) => ({
        sourceApiName: report.sourceApiName,
        objectApiName: report.objectApiName,
        watermark: report.cursor.watermark,
      })),
    );
    await dependencies.updateState(state, {
      status: "succeeded",
      lastCompletedAt: completedAt.toISOString(),
      lastError: null,
      apiBudget: connector.budgetSnapshot(),
    });
    const completed = await dependencies.updateJob(
      payload.orgId,
      payload.processingJobId,
      {
        status: "succeeded",
        progress: { stage: "complete", objects: reports.length },
        result: {
          app_id: state.appId,
          source_instance_id: state.sourceInstanceId,
          reports,
        },
        error: null,
        finishedAt: completedAt,
      },
      ["running"],
    );
    if (!completed) {
      throw new RecordsActionLeaseLostError(
        `Salesforce sync ${payload.processingJobId} lost its processing-job lease`,
      );
    }
  } catch (error) {
    const failure = message(error);
    if (retryable(error)) {
      await dependencies.updateState(state, {
        status: "retrying",
        lastError: failure,
        apiBudget: connector?.budgetSnapshot() ?? state.apiBudget,
      });
      await dependencies.updateJob(payload.orgId, payload.processingJobId, {
        status: "retrying",
        progress: { stage: "retrying" },
        error: failure,
      });
      throw error;
    }
    const failedAt = dependencies.now();
    await dependencies.updateState(state, {
      status: "failed",
      lastCompletedAt: failedAt.toISOString(),
      lastError: failure,
      apiBudget: connector?.budgetSnapshot() ?? state.apiBudget,
    });
    await dependencies.updateJob(payload.orgId, payload.processingJobId, {
      status: "failed",
      progress: { stage: "failed" },
      error: failure,
      finishedAt: failedAt,
    });
  }
}
