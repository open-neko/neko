import { and, app_state, db, eq, sql } from "@neko/db";
import type {
  JsonObject,
  RecordAppWriteMode,
  SalesforceApiBudgetSnapshot,
} from "@neko/records";

export type SalesforceSyncObjectState = {
  sourceApiName: string;
  objectApiName: string;
  watermark: JsonObject;
};

export type SalesforceCutoverState = {
  actionRequestId: string;
  processingJobId: string | null;
  finalSyncJobId: string | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
};

export type SalesforceSyncState = {
  orgId: string;
  appId: string;
  appStatus: string;
  mode: RecordAppWriteMode;
  sourceInstanceId: string;
  exportActionRequestId: string;
  objects: SalesforceSyncObjectState[];
  enabled: boolean;
  intervalMinutes: number;
  status: string;
  lastEnqueuedAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  apiBudget: SalesforceApiBudgetSnapshot | null;
  cutover: SalesforceCutoverState | null;
};

export class SalesforceSyncStateError extends Error {
  readonly code = "records_salesforce_sync_state_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SalesforceSyncStateError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalTimestamp(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function apiBudget(value: unknown): SalesforceApiBudgetSnapshot | null {
  if (value === undefined || value === null) return null;
  const budget = asRecord(value);
  if (
    !budget ||
    typeof budget.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(budget.day) ||
    !Number.isSafeInteger(budget.used) ||
    Number(budget.used) < 0 ||
    !Number.isSafeInteger(budget.limit) ||
    Number(budget.limit) < 1
  ) {
    throw new SalesforceSyncStateError("Salesforce API budget checkpoint is invalid");
  }
  return { day: budget.day, used: Number(budget.used), limit: Number(budget.limit) };
}

function cutoverState(value: unknown): SalesforceCutoverState | null {
  if (value === undefined || value === null) return null;
  const cutover = asRecord(value);
  if (!cutover || typeof cutover.action_request_id !== "string") {
    throw new SalesforceSyncStateError("Salesforce cutover checkpoint is invalid");
  }
  return {
    actionRequestId: cutover.action_request_id,
    processingJobId:
      typeof cutover.processing_job_id === "string" ? cutover.processing_job_id : null,
    finalSyncJobId:
      typeof cutover.final_sync_job_id === "string" ? cutover.final_sync_job_id : null,
    status: typeof cutover.status === "string" ? cutover.status : "unknown",
    startedAt: optionalTimestamp(cutover.started_at),
    completedAt: optionalTimestamp(cutover.completed_at),
    lastError: typeof cutover.last_error === "string" ? cutover.last_error : null,
  };
}

function parseObject(value: unknown): SalesforceSyncObjectState {
  const object = asRecord(value);
  const sourceApiName = object?.source_api_name;
  const objectApiName = object?.object_api_name;
  const watermark = asRecord(object?.watermark);
  if (
    typeof sourceApiName !== "string" ||
    !sourceApiName ||
    typeof objectApiName !== "string" ||
    !objectApiName ||
    !watermark
  ) {
    throw new SalesforceSyncStateError("Salesforce sync object metadata is incomplete");
  }
  return { sourceApiName, objectApiName, watermark };
}

export async function getSalesforceSyncState(
  orgId: string,
  appId: string,
): Promise<SalesforceSyncState | null> {
  const rows = await db()
    .select({ status: app_state.status, config: app_state.config })
    .from(app_state)
    .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, appId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const config = row.config;
  const connector = asRecord(config.connector);
  const sync = asRecord(connector?.sync) ?? {};
  const mode = config.mode;
  const sourceInstanceId = connector?.source_instance_id;
  const exportActionRequestId = connector?.export_action_request_id;
  const objects = connector?.objects;
  if (
    connector?.kind !== "salesforce" ||
    (mode !== "mirror" && mode !== "cutting_over" && mode !== "primary") ||
    typeof sourceInstanceId !== "string" ||
    typeof exportActionRequestId !== "string" ||
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.length > 500
  ) {
    throw new SalesforceSyncStateError(
      `app ${appId} is missing its completed Salesforce connector metadata`,
    );
  }
  const interval = sync.interval_minutes;
  return {
    orgId,
    appId,
    appStatus: row.status,
    mode,
    sourceInstanceId,
    exportActionRequestId,
    objects: objects.map(parseObject),
    enabled: sync.enabled === true,
    intervalMinutes:
      Number.isSafeInteger(interval) && Number(interval) >= 5 && Number(interval) <= 1_440
        ? Number(interval)
        : 15,
    status: typeof sync.status === "string" ? sync.status : "disabled",
    lastEnqueuedAt: optionalTimestamp(sync.last_enqueued_at),
    lastStartedAt: optionalTimestamp(sync.last_started_at),
    lastCompletedAt: optionalTimestamp(sync.last_completed_at),
    lastError: typeof sync.last_error === "string" ? sync.last_error : null,
    apiBudget: apiBudget(sync.api_budget),
    cutover: cutoverState(connector.cutover),
  };
}

async function mergeSyncState(
  state: SalesforceSyncState,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db()
    .update(app_state)
    .set({
      config: sql`jsonb_set(
        ${app_state.config},
        '{connector,sync}',
        coalesce(${app_state.config} #> '{connector,sync}', '{}'::jsonb)
          || ${JSON.stringify(patch)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(app_state.org_id, state.orgId),
        eq(app_state.app_id, state.appId),
        sql`${app_state.config}->'connector'->>'kind' = 'salesforce'`,
        sql`${app_state.config}->'connector'->>'source_instance_id' = ${state.sourceInstanceId}`,
      ),
    )
    .returning({ appId: app_state.app_id });
  if (rows.length !== 1) {
    throw new SalesforceSyncStateError("Salesforce connector state disappeared or changed");
  }
}

export async function enableSalesforceSync(
  orgId: string,
  appId: string,
  intervalMinutes: number,
): Promise<SalesforceSyncState> {
  const state = await getSalesforceSyncState(orgId, appId);
  if (!state || state.appStatus !== "active") {
    throw new SalesforceSyncStateError("Salesforce sync requires an active imported app");
  }
  if (state.mode === "primary") {
    throw new SalesforceSyncStateError("Salesforce sync cannot be enabled after cutover");
  }
  if (
    !Number.isSafeInteger(intervalMinutes) ||
    intervalMinutes < 5 ||
    intervalMinutes > 1_440
  ) {
    throw new SalesforceSyncStateError("interval_minutes must be between 5 and 1440");
  }
  await mergeSyncState(state, {
    enabled: true,
    interval_minutes: intervalMinutes,
    status: "queued",
    last_enqueued_at: new Date().toISOString(),
    last_error: null,
  });
  return (await getSalesforceSyncState(orgId, appId))!;
}

export async function updateSalesforceSyncState(
  state: SalesforceSyncState,
  patch: {
    status: string;
    lastEnqueuedAt?: string;
    lastStartedAt?: string;
    lastCompletedAt?: string;
    lastError?: string | null;
    enabled?: boolean;
    apiBudget?: SalesforceApiBudgetSnapshot | null;
  },
): Promise<void> {
  await mergeSyncState(state, {
    status: patch.status,
    ...(patch.lastEnqueuedAt ? { last_enqueued_at: patch.lastEnqueuedAt } : {}),
    ...(patch.lastStartedAt ? { last_started_at: patch.lastStartedAt } : {}),
    ...(patch.lastCompletedAt ? { last_completed_at: patch.lastCompletedAt } : {}),
    ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.apiBudget !== undefined ? { api_budget: patch.apiBudget } : {}),
  });
}

export async function mirrorSalesforceSyncWatermarks(
  state: SalesforceSyncState,
  watermarks: Array<{
    sourceApiName: string;
    objectApiName: string;
    watermark: JsonObject;
  }>,
): Promise<void> {
  const nextByObject = new Map(
    watermarks.map((entry) => [
      `${entry.sourceApiName}\u0000${entry.objectApiName}`,
      entry.watermark,
    ]),
  );
  const objects = state.objects.map((object) => ({
    source_api_name: object.sourceApiName,
    object_api_name: object.objectApiName,
    watermark:
      nextByObject.get(`${object.sourceApiName}\u0000${object.objectApiName}`) ??
      object.watermark,
  }));
  const rows = await db()
    .update(app_state)
    .set({
      config: sql`jsonb_set(
        ${app_state.config},
        '{connector,objects}',
        ${JSON.stringify(objects)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(app_state.org_id, state.orgId),
        eq(app_state.app_id, state.appId),
        sql`${app_state.config}->'connector'->>'kind' = 'salesforce'`,
        sql`${app_state.config}->'connector'->>'source_instance_id' = ${state.sourceInstanceId}`,
      ),
    )
    .returning({ appId: app_state.app_id });
  if (rows.length !== 1) {
    throw new SalesforceSyncStateError("Salesforce connector state disappeared or changed");
  }
}

async function mergeCutoverState(
  state: SalesforceSyncState,
  patch: Record<string, unknown>,
): Promise<void> {
  const rows = await db()
    .update(app_state)
    .set({
      config: sql`jsonb_set(
        ${app_state.config},
        '{connector,cutover}',
        coalesce(${app_state.config} #> '{connector,cutover}', '{}'::jsonb)
          || ${JSON.stringify(patch)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(app_state.org_id, state.orgId),
        eq(app_state.app_id, state.appId),
        sql`${app_state.config}->'connector'->>'source_instance_id' = ${state.sourceInstanceId}`,
        sql`${app_state.config}->'connector'->'cutover'->>'action_request_id' = ${state.cutover?.actionRequestId ?? ""}`,
      ),
    )
    .returning({ appId: app_state.app_id });
  if (rows.length !== 1) {
    throw new SalesforceSyncStateError("Salesforce cutover state disappeared or changed");
  }
}

export async function beginSalesforceCutover(
  orgId: string,
  appId: string,
  actionRequestId: string,
): Promise<SalesforceSyncState> {
  const state = await getSalesforceSyncState(orgId, appId);
  if (!state || state.appStatus !== "active") {
    throw new SalesforceSyncStateError("Salesforce cutover requires an active imported app");
  }
  if (state.mode === "primary") {
    throw new SalesforceSyncStateError("Salesforce app is already primary");
  }
  if (
    state.mode === "cutting_over" &&
    state.cutover?.actionRequestId !== actionRequestId &&
    state.cutover?.status !== "failed"
  ) {
    throw new SalesforceSyncStateError("Salesforce cutover is already in progress");
  }
  const startedAt = new Date().toISOString();
  const cutover = {
    action_request_id: actionRequestId,
    processing_job_id: null,
    final_sync_job_id: null,
    status: "queued",
    started_at: startedAt,
    completed_at: null,
    last_error: null,
  };
  const rows = await db()
    .update(app_state)
    .set({
      config: sql`jsonb_set(
        jsonb_set(
          jsonb_set(
            ${app_state.config},
            '{mode}',
            '"cutting_over"'::jsonb,
            true
          ),
          '{connector,sync}',
          coalesce(${app_state.config} #> '{connector,sync}', '{}'::jsonb)
            || ${JSON.stringify({ enabled: false, status: "cutover_frozen" })}::jsonb,
          true
        ),
        '{connector,cutover}',
        ${JSON.stringify(cutover)}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(app_state.org_id, orgId),
        eq(app_state.app_id, appId),
        eq(app_state.status, "active"),
        sql`${app_state.config}->>'mode' = ${state.mode}`,
        sql`${app_state.config}->'connector'->>'source_instance_id' = ${state.sourceInstanceId}`,
        ...(state.mode === "cutting_over"
          ? [
              sql`${app_state.config}->'connector'->'cutover'->>'action_request_id' = ${state.cutover?.actionRequestId ?? ""}`,
            ]
          : []),
      ),
    )
    .returning({ appId: app_state.app_id });
  if (rows.length !== 1) {
    throw new SalesforceSyncStateError("Salesforce cutover state changed concurrently");
  }
  const next = await getSalesforceSyncState(orgId, appId);
  if (next?.cutover?.actionRequestId !== actionRequestId) {
    throw new SalesforceSyncStateError("Salesforce cutover state changed concurrently");
  }
  return next;
}

export async function bindSalesforceCutoverJob(
  state: SalesforceSyncState,
  processingJobId: string,
): Promise<void> {
  await mergeCutoverState(state, { processing_job_id: processingJobId });
}

export async function updateSalesforceCutoverState(
  state: SalesforceSyncState,
  patch: {
    status: string;
    finalSyncJobId?: string;
    completedAt?: string;
    lastError?: string | null;
  },
): Promise<void> {
  await mergeCutoverState(state, {
    status: patch.status,
    ...(patch.finalSyncJobId ? { final_sync_job_id: patch.finalSyncJobId } : {}),
    ...(patch.completedAt ? { completed_at: patch.completedAt } : {}),
    ...(patch.lastError !== undefined ? { last_error: patch.lastError } : {}),
  });
}

export async function completeSalesforceCutover(
  state: SalesforceSyncState,
  completedAt: string,
): Promise<void> {
  const rows = await db()
    .update(app_state)
    .set({
      config: sql`jsonb_set(
        jsonb_set(
          jsonb_set(
            ${app_state.config},
            '{mode}',
            '"primary"'::jsonb,
            true
          ),
          '{connector,sync}',
          coalesce(${app_state.config} #> '{connector,sync}', '{}'::jsonb)
            || ${JSON.stringify({ enabled: false, status: "disabled" })}::jsonb,
          true
        ),
        '{connector,cutover}',
        coalesce(${app_state.config} #> '{connector,cutover}', '{}'::jsonb)
          || ${JSON.stringify({
            status: "succeeded",
            completed_at: completedAt,
            last_error: null,
          })}::jsonb,
        true
      )`,
    })
    .where(
      and(
        eq(app_state.org_id, state.orgId),
        eq(app_state.app_id, state.appId),
        sql`${app_state.config}->>'mode' = 'cutting_over'`,
        sql`${app_state.config}->'connector'->>'source_instance_id' = ${state.sourceInstanceId}`,
        sql`${app_state.config}->'connector'->'cutover'->>'action_request_id' = ${state.cutover?.actionRequestId ?? ""}`,
      ),
    )
    .returning({ appId: app_state.app_id });
  if (rows.length !== 1) {
    throw new SalesforceSyncStateError("Salesforce cutover state disappeared or changed");
  }
}
