import {
  RECORD_BACKFILL_TRANSFORMS,
  RecordBackfillAuditError,
  RecordsActionLeaseBusyError,
  RecordsActionLeaseLostError,
  RecordsGraphjinRequestError,
  type RecordBackfillReport,
  type RecordBackfillRequest,
  type RecordBackfillTransform,
} from "@neko/records";
import {
  registerActionAdapter,
  RetryableActionAdapterError,
  type ActionAdapter,
  type ActionRequestRecord,
} from "@neko/llm/workflows";

export const RECORD_BACKFILL_ACTION_KINDS = ["record_backfill"] as const;

export const RECORD_BACKFILL_ACTION_DESCRIPTORS = [
  {
    kind: "record_backfill",
    scope: "internal",
    description:
      "Populate a newly added field on live records with a reviewed constant or an explicit source-field transform. Existing target values and recycled rows are never changed.",
    default_mode: "ask",
    example: {
      app: "crm",
      object: "account",
      from: "annual_revenue_text",
      to: "annual_revenue",
      transform: "decimal",
    },
  },
] as const;

export class RecordBackfillActionPayloadError extends Error {
  readonly code = "records_backfill_action_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordBackfillActionPayloadError";
  }
}

export type RecordBackfillActionExecutor = {
  execute(request: RecordBackfillRequest): Promise<RecordBackfillReport>;
};

function requiredString(
  payload: Record<string, unknown>,
  field: string,
): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) {
    throw new RecordBackfillActionPayloadError(
      `${field}: a non-empty string is required`,
    );
  }
  return value.trim();
}

function assertOnlyKeys(
  payload: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(payload).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new RecordBackfillActionPayloadError(
      `unknown payload field${unknown.length === 1 ? "" : "s"}: ${unknown
        .sort()
        .join(", ")}`,
    );
  }
}

function transform(payload: Record<string, unknown>): RecordBackfillTransform {
  const value = payload.transform ?? "copy";
  if (
    typeof value !== "string" ||
    !RECORD_BACKFILL_TRANSFORMS.includes(value as RecordBackfillTransform)
  ) {
    throw new RecordBackfillActionPayloadError(
      `transform: expected one of ${RECORD_BACKFILL_TRANSFORMS.join(", ")}`,
    );
  }
  return value as RecordBackfillTransform;
}

function backfillRequest(request: ActionRequestRecord): RecordBackfillRequest {
  if (request.actorRole !== "admin") {
    throw new RecordBackfillActionPayloadError(
      "record backfill requires an admin actor snapshot",
    );
  }
  assertOnlyKeys(request.payload, [
    "app",
    "object",
    "from",
    "to",
    "transform",
    "value",
  ]);
  const hasSource = Object.prototype.hasOwnProperty.call(
    request.payload,
    "from",
  );
  const hasValue = Object.prototype.hasOwnProperty.call(
    request.payload,
    "value",
  );
  if (hasSource === hasValue) {
    throw new RecordBackfillActionPayloadError(
      "record backfill requires exactly one of from or value",
    );
  }
  const common = {
    actionRequestId: request.id,
    orgId: request.orgId,
    appId: requiredString(request.payload, "app"),
    objectApiName: requiredString(request.payload, "object"),
    targetFieldApiName: requiredString(request.payload, "to"),
    actorUserId:
      request.actorUserId?.trim() ||
      `urn:openneko:solo-admin:${request.orgId}`,
  };
  if (hasSource) {
    return {
      ...common,
      sourceFieldApiName: requiredString(request.payload, "from"),
      transform: transform(request.payload),
    };
  }
  if (Object.prototype.hasOwnProperty.call(request.payload, "transform")) {
    throw new RecordBackfillActionPayloadError(
      "transform is only valid with a source field",
    );
  }
  return { ...common, value: request.payload.value };
}

function retryable(error: unknown): boolean {
  if (
    error instanceof RecordBackfillAuditError ||
    error instanceof RecordsActionLeaseBusyError ||
    error instanceof RecordsActionLeaseLostError
  ) {
    return true;
  }
  if (error instanceof RecordsGraphjinRequestError) {
    return (
      error.status === null ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      (error.status === 200 && error.graphjinErrors.length === 0)
    );
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

export function createRecordBackfillActionAdapter(
  executor: RecordBackfillActionExecutor,
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== "record_backfill") {
      throw new RecordBackfillActionPayloadError(
        `record backfill adapter cannot execute action kind ${request.kind}`,
      );
    }
    try {
      const result = await executor.execute(backfillRequest(request));
      return {
        commandOrOperation: request.kind,
        externalRef: `${result.appId}:${result.objectApiName}.${result.targetFieldApiName}`,
        result: { ...result },
      };
    } catch (error) {
      if (retryable(error)) {
        throw new RetryableActionAdapterError(
          `record backfill ${request.id} is temporarily unavailable and will be retried`,
          { cause: error },
        );
      }
      throw error;
    }
  };
}

export function registerRecordBackfillAction(
  executor: RecordBackfillActionExecutor,
  register: (kind: string, adapter: ActionAdapter) => void =
    registerActionAdapter,
): void {
  register("record_backfill", createRecordBackfillActionAdapter(executor));
}
