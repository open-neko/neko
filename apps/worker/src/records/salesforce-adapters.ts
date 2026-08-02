import {
  and,
  db,
  eq,
  inArray,
  processing_job,
  sql,
} from "@neko/db";
import type {
  RecordsSalesforceCutoverPayload,
  RecordsSalesforceExportPayload,
  RecordsSalesforceSyncPayload,
} from "@neko/db/jobs";
import type {
  RecordConnectorInventory,
  SalesforceConnector,
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
  createSalesforceConnectorForAction,
  parseApprovedSalesforceSchemaReview,
  parseSalesforceActionConfig,
  SalesforceActionConfigError,
} from "./salesforce-runtime.js";
import {
  beginSalesforceCutover,
  bindSalesforceCutoverJob,
  enableSalesforceSync,
  type SalesforceSyncState,
} from "./salesforce-sync-state.js";

export const RECORD_SALESFORCE_ACTION_KINDS = [
  "records_salesforce_discover",
  "records_salesforce_export_start",
  "records_salesforce_export_status",
  "records_salesforce_export_cancel",
  "records_salesforce_sync_delta",
  "records_salesforce_cutover",
] as const;

export type RecordSalesforceActionKind =
  (typeof RECORD_SALESFORCE_ACTION_KINDS)[number];

export const RECORD_SALESFORCE_ACTION_DESCRIPTORS = [
  {
    kind: "records_salesforce_discover",
    scope: "external",
    description:
      "Inspect Salesforce objects, row estimates, and describe metadata using a named secret reference; credentials never enter the action payload.",
    default_mode: "auto",
    example: {
      source_instance_id: "salesforce-production",
      instance_url: "https://example.my.salesforce.com",
      client_id: "connected-app-client-id",
      client_secret_ref: "salesforce-production-client-secret",
      app: "crm",
      label: "CRM",
      mode: "mirror",
      objects: ["Account", "Contact", "Opportunity", "User"],
    },
  },
  {
    kind: "records_salesforce_export_start",
    scope: "external",
    description:
      "Start a resumable Salesforce Bulk API export into an organization-scoped artifact directory after discovery is reviewed.",
    default_mode: "ask",
    example: {
      source_instance_id: "salesforce-production",
      instance_url: "https://example.my.salesforce.com",
      client_id: "connected-app-client-id",
      client_secret_ref: "salesforce-production-client-secret",
      app: "crm",
      label: "CRM",
      mode: "mirror",
      objects: ["Account", "Contact", "Opportunity", "User"],
    },
  },
  {
    kind: "records_salesforce_export_status",
    scope: "internal",
    description: "Read durable Salesforce export progress and the completed artifact manifest.",
    default_mode: { internal: "auto" },
    example: { export_job_id: "00000000-0000-4000-a000-000000000001" },
  },
  {
    kind: "records_salesforce_export_cancel",
    scope: "external",
    description:
      "Cancel a Salesforce export; completed checkpointed pages remain available for a safe resume.",
    default_mode: "ask",
    example: { export_job_id: "00000000-0000-4000-a000-000000000001" },
  },
  {
    kind: "records_salesforce_sync_delta",
    scope: "external",
    description:
      "Enable scheduled one-way Salesforce delta sync for an imported mirror app; each run advances target-side watermarks only after all governed writes reconcile.",
    default_mode: "ask",
    example: { app: "crm", interval_minutes: 15 },
  },
  {
    kind: "records_salesforce_cutover",
    scope: "external",
    description:
      "Freeze a Salesforce mirror, apply and verify one final inbound delta, then atomically make OpenNeko the primary writable system.",
    default_mode: "ask",
    example: { app: "crm" },
  },
] as const;

export class RecordSalesforceActionPayloadError extends Error {
  readonly code = "records_salesforce_action_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordSalesforceActionPayloadError";
  }
}

export type SalesforceExportJobSummary = {
  id: string;
  status: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecordSalesforceActionDependencies = {
  connectorForAction: (request: ActionRequestRecord) => Promise<
    Pick<SalesforceConnector, "discover" | "schemaReview">
  >;
  createExport: (request: ActionRequestRecord) => Promise<SalesforceExportJobSummary>;
  getExport: (orgId: string, id: string) => Promise<SalesforceExportJobSummary | null>;
  cancelExport: (orgId: string, id: string) => Promise<SalesforceExportJobSummary | null>;
  enqueueExport: (payload: RecordsSalesforceExportPayload) => Promise<string | null>;
  enableSync: (
    request: ActionRequestRecord,
    intervalMinutes: number,
  ) => Promise<SalesforceSyncState>;
  createSync: (
    request: ActionRequestRecord,
    state: SalesforceSyncState,
  ) => Promise<SalesforceExportJobSummary>;
  enqueueSync: (payload: RecordsSalesforceSyncPayload) => Promise<string | null>;
  beginCutover: (
    request: ActionRequestRecord,
    appId: string,
  ) => Promise<SalesforceSyncState>;
  createCutover: (
    request: ActionRequestRecord,
    state: SalesforceSyncState,
  ) => Promise<SalesforceExportJobSummary>;
  bindCutoverJob: (state: SalesforceSyncState, processingJobId: string) => Promise<void>;
  enqueueCutover: (payload: RecordsSalesforceCutoverPayload) => Promise<string | null>;
};

const CONNECTOR_KEYS = [
  "source_instance_id",
  "instance_url",
  "client_id",
  "client_secret_ref",
  "api_version",
  "daily_api_limit",
  "mode",
  "app",
  "label",
  "objects",
] as const;

const PREPARED_EXPORT_KEYS = [
  "salesforce_inventory",
  "salesforce_schema_review",
] as const;

function assertOnlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new RecordSalesforceActionPayloadError(
      `unknown payload field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`,
    );
  }
}

function exportJobId(request: ActionRequestRecord): string {
  assertOnlyKeys(request.payload, ["export_job_id"]);
  const id = request.payload.export_job_id;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    throw new RecordSalesforceActionPayloadError("export_job_id: a UUID is required");
  }
  return id;
}

function syncPayload(request: ActionRequestRecord): {
  appId: string;
  intervalMinutes: number;
} {
  assertOnlyKeys(request.payload, ["app", "interval_minutes"]);
  const app = request.payload.app;
  const interval = request.payload.interval_minutes ?? 15;
  if (typeof app !== "string" || !app.trim() || app.trim().length > 500) {
    throw new RecordSalesforceActionPayloadError("app: a non-empty string is required");
  }
  if (!Number.isSafeInteger(interval) || Number(interval) < 5 || Number(interval) > 1_440) {
    throw new RecordSalesforceActionPayloadError(
      "interval_minutes: an integer between 5 and 1440 is required",
    );
  }
  return { appId: app.trim(), intervalMinutes: Number(interval) };
}

function cutoverPayload(request: ActionRequestRecord): { appId: string } {
  assertOnlyKeys(request.payload, ["app"]);
  const app = request.payload.app;
  if (typeof app !== "string" || !app.trim() || app.trim().length > 500) {
    throw new RecordSalesforceActionPayloadError("app: a non-empty string is required");
  }
  return { appId: app.trim() };
}

function assertAdmin(request: ActionRequestRecord): void {
  if (request.actorRole !== "admin") {
    throw new RecordSalesforceActionPayloadError(
      "Salesforce connector controls require an admin actor snapshot",
    );
  }
}

function retryable(error: unknown): boolean {
  const explicitRetryable =
    typeof error === "object" && error !== null && "retryable" in error
      ? (error as { retryable?: unknown }).retryable
      : undefined;
  if (typeof explicitRetryable === "boolean") return explicitRetryable;
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return (
    status === null ||
    status === 408 ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    code.startsWith("08") ||
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)
  );
}

function connectorPayload(
  request: ActionRequestRecord,
  options: { requireReview?: boolean } = {},
): void {
  assertOnlyKeys(request.payload, [
    ...CONNECTOR_KEYS,
    ...(options.requireReview ? PREPARED_EXPORT_KEYS : []),
  ]);
  try {
    parseSalesforceActionConfig(request.payload);
    if (options.requireReview) parseApprovedSalesforceSchemaReview(request.payload);
  } catch (error) {
    if (error instanceof SalesforceActionConfigError) {
      throw new RecordSalesforceActionPayloadError(error.message);
    }
    throw error;
  }
}

/** Resolve and attach the exact migration plan before the approval card exists. */
export function createRecordSalesforceExportPreflightHook(input: {
  connectorForAction: RecordSalesforceActionDependencies["connectorForAction"];
  updatePayload?: typeof updateActionRequestPayload;
}): ActionRequestCreatedHook {
  const updatePayload = input.updatePayload ?? updateActionRequestPayload;
  return async (request) => {
    if (request.kind !== "records_salesforce_export_start") return;
    assertAdmin(request);
    connectorPayload(request);
    const connector = await input.connectorForAction(request);
    // Discovery includes counts for the human plan. The review contains the
    // complete object/field/mapping schema and reuses the cached describes.
    const inventory = await connector.discover();
    const review = await connector.schemaReview();
    const prepared = {
      ...request.payload,
      salesforce_inventory: inventory,
      salesforce_schema_review: review,
    };
    parseApprovedSalesforceSchemaReview(prepared);
    return updatePayload({
      id: request.id,
      orgId: request.orgId,
      payload: prepared,
    });
  };
}

function mapJob(row: typeof processing_job.$inferSelect): SalesforceExportJobSummary {
  return {
    id: row.id,
    status: row.status,
    progress: (row.progress as Record<string, unknown>) ?? {},
    result: (row.result as Record<string, unknown> | null) ?? null,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const defaultSalesforceActionDependencies: RecordSalesforceActionDependencies = {
  connectorForAction: createSalesforceConnectorForAction,
  createExport: async (request) =>
    db().transaction(async (transaction) => {
      // The action executor can itself be retried. Serialize creation by the
      // immutable action id so concurrent deliveries cannot launch two exports.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.orgId}:${request.id}`}, 0))`,
      );
      const existing = await transaction
        .select()
        .from(processing_job)
        .where(
          and(
            eq(processing_job.org_id, request.orgId),
            eq(processing_job.kind, "records_salesforce_export"),
            sql`${processing_job.trigger_payload}->>'action_request_id' = ${request.id}`,
          ),
        )
        .limit(1);
      if (existing[0]) return mapJob(existing[0]);
      const [row] = await transaction
        .insert(processing_job)
        .values({
          org_id: request.orgId,
          kind: "records_salesforce_export",
          status: "queued",
          trigger: "action_request",
          trigger_payload: {
            action_request_id: request.id,
            source_instance_id: request.payload.source_instance_id,
            app: request.payload.app,
          },
          progress: { stage: "queued" },
        })
        .returning();
      if (!row) throw new Error("Salesforce export job could not be created");
      return mapJob(row);
    }),
  getExport: async (orgId, id) => {
    const rows = await db()
      .select()
      .from(processing_job)
      .where(
        and(
          eq(processing_job.org_id, orgId),
          eq(processing_job.id, id),
          eq(processing_job.kind, "records_salesforce_export"),
        ),
      )
      .limit(1);
    return rows[0] ? mapJob(rows[0]) : null;
  },
  cancelExport: async (orgId, id) => {
    const rows = await db()
      .update(processing_job)
      .set({ status: "cancel_requested", updated_at: new Date() })
      .where(
        and(
          eq(processing_job.org_id, orgId),
          eq(processing_job.id, id),
          eq(processing_job.kind, "records_salesforce_export"),
          inArray(processing_job.status, ["queued", "running"]),
        ),
      )
      .returning();
    if (rows[0]) return mapJob(rows[0]);
    const existing = await defaultSalesforceActionDependencies.getExport(orgId, id);
    return existing;
  },
  enqueueExport: async () => {
    throw new Error("Salesforce export queue is not configured");
  },
  enableSync: async (request, intervalMinutes) =>
    enableSalesforceSync(
      request.orgId,
      String(request.payload.app ?? ""),
      intervalMinutes,
    ),
  createSync: async (request, state) =>
    db().transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.orgId}:${request.id}:salesforce-sync`}, 0))`,
      );
      const existing = await transaction
        .select()
        .from(processing_job)
        .where(
          and(
            eq(processing_job.org_id, request.orgId),
            eq(processing_job.kind, "records_salesforce_sync"),
            sql`${processing_job.trigger_payload}->>'action_request_id' = ${request.id}`,
          ),
        )
        .limit(1);
      if (existing[0]) return mapJob(existing[0]);
      const [row] = await transaction
        .insert(processing_job)
        .values({
          org_id: request.orgId,
          kind: "records_salesforce_sync",
          status: "queued",
          trigger: "action_request",
          trigger_payload: {
            action_request_id: request.id,
            app_id: state.appId,
            source_instance_id: state.sourceInstanceId,
          },
          progress: { stage: "queued" },
        })
        .returning();
      if (!row) throw new Error("Salesforce sync job could not be created");
      return mapJob(row);
    }),
  enqueueSync: async () => {
    throw new Error("Salesforce sync queue is not configured");
  },
  beginCutover: async (request, appId) =>
    beginSalesforceCutover(request.orgId, appId, request.id),
  createCutover: async (request, state) =>
    db().transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${request.orgId}:${request.id}:salesforce-cutover`}, 0))`,
      );
      const existing = await transaction
        .select()
        .from(processing_job)
        .where(
          and(
            eq(processing_job.org_id, request.orgId),
            eq(processing_job.kind, "records_salesforce_cutover"),
            sql`${processing_job.trigger_payload}->>'action_request_id' = ${request.id}`,
          ),
        )
        .limit(1);
      if (existing[0]) return mapJob(existing[0]);
      const [row] = await transaction
        .insert(processing_job)
        .values({
          org_id: request.orgId,
          kind: "records_salesforce_cutover",
          status: "queued",
          trigger: "action_request",
          trigger_payload: {
            action_request_id: request.id,
            app_id: state.appId,
            source_instance_id: state.sourceInstanceId,
          },
          progress: { stage: "queued" },
        })
        .returning();
      if (!row) throw new Error("Salesforce cutover job could not be created");
      return mapJob(row);
    }),
  bindCutoverJob: bindSalesforceCutoverJob,
  enqueueCutover: async () => {
    throw new Error("Salesforce cutover queue is not configured");
  },
};

export function createRecordSalesforceActionAdapter(
  kind: RecordSalesforceActionKind,
  dependencies: RecordSalesforceActionDependencies,
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== kind) {
      throw new RecordSalesforceActionPayloadError(
        `adapter ${kind} cannot execute action kind ${request.kind}`,
      );
    }
    assertAdmin(request);
    if (kind === "records_salesforce_discover") {
      connectorPayload(request);
      try {
        const connector = await dependencies.connectorForAction(request);
        const inventory: RecordConnectorInventory = await connector.discover();
        const schemaReview = await connector.schemaReview();
        return {
          commandOrOperation: kind,
          externalRef: inventory.sourceInstanceId,
          result: { ...inventory, schemaReview },
        };
      } catch (error) {
        if (retryable(error)) {
          throw new RetryableActionAdapterError(
            `Salesforce discovery ${request.id} is temporarily unavailable and will be retried`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    if (kind === "records_salesforce_export_start") {
      connectorPayload(request, { requireReview: true });
      const job = await dependencies.createExport(request);
      let queueId: string | null;
      try {
        queueId = await dependencies.enqueueExport({
          processingJobId: job.id,
          orgId: request.orgId,
          actionRequestId: request.id,
          exportJobId: job.id,
        });
      } catch (error) {
        throw new RetryableActionAdapterError(
          `Salesforce export ${job.id} could not be queued and will be retried`,
          { cause: error },
        );
      }
      return {
        commandOrOperation: kind,
        externalRef: job.id,
        result: {
          ...job,
          queueId,
          ...(queueId === null ? { deduplicated: true } : {}),
        },
      };
    }
    if (kind === "records_salesforce_sync_delta") {
      const payload = syncPayload(request);
      const state = await dependencies.enableSync(request, payload.intervalMinutes);
      const job = await dependencies.createSync(request, state);
      let queueId: string | null;
      try {
        queueId = await dependencies.enqueueSync({
          processingJobId: job.id,
          orgId: request.orgId,
          appId: state.appId,
          sourceInstanceId: state.sourceInstanceId,
        });
      } catch (error) {
        throw new RetryableActionAdapterError(
          `Salesforce sync ${job.id} could not be queued and will be retried`,
          { cause: error },
        );
      }
      return {
        commandOrOperation: kind,
        externalRef: job.id,
        result: {
          ...job,
          appId: state.appId,
          sourceInstanceId: state.sourceInstanceId,
          intervalMinutes: state.intervalMinutes,
          queueId,
          ...(queueId === null ? { deduplicated: true } : {}),
        },
      };
    }
    if (kind === "records_salesforce_cutover") {
      const payload = cutoverPayload(request);
      const state = await dependencies.beginCutover(request, payload.appId);
      const job = await dependencies.createCutover(request, state);
      await dependencies.bindCutoverJob(state, job.id);
      let queueId: string | null;
      try {
        queueId = await dependencies.enqueueCutover({
          processingJobId: job.id,
          orgId: request.orgId,
          appId: state.appId,
          sourceInstanceId: state.sourceInstanceId,
        });
      } catch (error) {
        throw new RetryableActionAdapterError(
          `Salesforce cutover ${job.id} could not be queued and will be retried`,
          { cause: error },
        );
      }
      return {
        commandOrOperation: kind,
        externalRef: job.id,
        result: {
          ...job,
          appId: state.appId,
          sourceInstanceId: state.sourceInstanceId,
          queueId,
          ...(queueId === null ? { deduplicated: true } : {}),
        },
      };
    }

    const id = exportJobId(request);
    const job =
      kind === "records_salesforce_export_cancel"
        ? await dependencies.cancelExport(request.orgId, id)
        : await dependencies.getExport(request.orgId, id);
    if (!job) throw new RecordSalesforceActionPayloadError("Salesforce export was not found");
    return {
      commandOrOperation: kind,
      externalRef: job.id,
      result: job,
    };
  };
}

export function registerRecordSalesforceActions(input: {
  enqueueExport: RecordSalesforceActionDependencies["enqueueExport"];
  enqueueSync: RecordSalesforceActionDependencies["enqueueSync"];
  enqueueCutover: RecordSalesforceActionDependencies["enqueueCutover"];
  dependencies?: Omit<
    RecordSalesforceActionDependencies,
    "enqueueExport" | "enqueueSync" | "enqueueCutover"
  >;
  register?: (kind: string, adapter: ActionAdapter) => void;
  registerPreflight?: (hook: ActionRequestCreatedHook) => () => void;
}): () => void {
  const dependencies: RecordSalesforceActionDependencies = {
    ...defaultSalesforceActionDependencies,
    ...input.dependencies,
    enqueueExport: input.enqueueExport,
    enqueueSync: input.enqueueSync,
    enqueueCutover: input.enqueueCutover,
  };
  const register = input.register ?? registerActionAdapter;
  for (const kind of RECORD_SALESFORCE_ACTION_KINDS) {
    register(kind, createRecordSalesforceActionAdapter(kind, dependencies));
  }
  return (input.registerPreflight ?? registerActionRequestCreatedHook)(
    createRecordSalesforceExportPreflightHook({
      connectorForAction: dependencies.connectorForAction,
    }),
  );
}
