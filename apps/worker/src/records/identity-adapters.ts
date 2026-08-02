import {
  RecordOwnerBackfillAuditError,
  RecordsActionLeaseBusyError,
  RecordsActionLeaseLostError,
  RecordsGraphjinRequestError,
  type RecordOwnerBackfillReport,
  type RecordOwnerBackfillRequest,
} from "@neko/records";
import {
  registerActionAdapter,
  RetryableActionAdapterError,
  type ActionAdapter,
  type ActionRequestRecord,
} from "@neko/llm/workflows";

export const RECORD_IDENTITY_ACTION_KINDS = ["records_identity_backfill"] as const;

export const RECORD_IDENTITY_ACTION_DESCRIPTORS = [
  {
    kind: "records_identity_backfill",
    scope: "internal",
    description:
      "Backfill generated-app ownership from linked, source-instance-scoped identities through audited GraphJin mutations.",
    default_mode: "ask",
    example: {
      app: "crm",
      source_instance_id: "salesforce-production",
      source_user_id: "005000000000001AAA",
    },
  },
] as const;

export class RecordIdentityActionPayloadError extends Error {
  readonly code = "records_identity_action_payload_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordIdentityActionPayloadError";
  }
}

export type RecordOwnerBackfillActionExecutor = {
  execute(request: RecordOwnerBackfillRequest): Promise<RecordOwnerBackfillReport>;
};

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string" || !value.trim() || value.trim().length > 500) {
    throw new RecordIdentityActionPayloadError(`${field}: a non-empty string is required`);
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  if (payload[field] === undefined || payload[field] === null) return undefined;
  return requiredString(payload, field);
}

function assertPayload(request: ActionRequestRecord): RecordOwnerBackfillRequest {
  if (request.actorRole !== "admin") {
    throw new RecordIdentityActionPayloadError("identity backfill requires an admin actor snapshot");
  }
  const allowed = new Set(["app", "source_instance_id", "source_user_id"]);
  const unknown = Object.keys(request.payload).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RecordIdentityActionPayloadError(
      `unknown payload field${unknown.length === 1 ? "" : "s"}: ${unknown.sort().join(", ")}`,
    );
  }
  return {
    actionRequestId: request.id,
    orgId: request.orgId,
    appId: requiredString(request.payload, "app"),
    sourceInstanceId: requiredString(request.payload, "source_instance_id"),
    actorUserId:
      request.actorUserId?.trim() || `urn:openneko:solo-admin:${request.orgId}`,
    ...(optionalString(request.payload, "source_user_id")
      ? { sourceUserId: optionalString(request.payload, "source_user_id") }
      : {}),
  };
}

function retryable(error: unknown): boolean {
  if (
    error instanceof RecordOwnerBackfillAuditError ||
    error instanceof RecordsActionLeaseBusyError ||
    error instanceof RecordsActionLeaseLostError
  ) {
    return true;
  }
  return (
    error instanceof RecordsGraphjinRequestError &&
    (error.status === null ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      (error.status === 200 && error.graphjinErrors.length === 0))
  );
}

export function createRecordIdentityActionAdapter(
  executor: RecordOwnerBackfillActionExecutor,
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== "records_identity_backfill") {
      throw new RecordIdentityActionPayloadError(
        `identity adapter cannot execute action kind ${request.kind}`,
      );
    }
    try {
      const result = await executor.execute(assertPayload(request));
      return {
        commandOrOperation: request.kind,
        externalRef: `${result.appId}:${result.sourceInstanceId}`,
        result: { ...result },
      };
    } catch (error) {
      if (retryable(error)) {
        throw new RetryableActionAdapterError(
          `identity backfill ${request.id} is temporarily unavailable and will be retried`,
          { cause: error },
        );
      }
      throw error;
    }
  };
}

export function registerRecordIdentityActions(
  executor: RecordOwnerBackfillActionExecutor,
  register: (kind: string, adapter: ActionAdapter) => void = registerActionAdapter,
): void {
  register("records_identity_backfill", createRecordIdentityActionAdapter(executor));
}
