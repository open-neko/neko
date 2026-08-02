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
