import {
  RECORD_SCHEMA_ACTIONS,
  RecordsSchemaApprovalStaleError,
  type PreparedRecordSchemaAction,
  type RecordSchemaActionRequest,
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

export const RECORD_SCHEMA_ACTION_KINDS = RECORD_SCHEMA_ACTIONS;

export const RECORD_SCHEMA_ACTION_DESCRIPTORS = [
  {
    kind: "app_create",
    scope: "internal",
    description:
      "Propose a complete generated app in one approval: permanent app/object/field names, relationships, ownership, permissions, layouts, and pages.",
    default_mode: "ask",
    example: {
      app: "support",
      label: "Support desk",
      purpose: "Track customer requests and ownership",
      objects: [
        {
          api_name: "ticket",
          label: "Ticket",
          plural_label: "Tickets",
          name_field: "subject",
          visibility: "owner",
          fields: [
            {
              api_name: "subject",
              label: "Subject",
              kind: "text",
              required: true,
            },
            {
              api_name: "status",
              label: "Status",
              kind: "picklist",
              picklist_values: ["new", "open", "closed"],
            },
          ],
          layouts: [
            {
              kind: "list",
              definition: { columns: ["subject", "status"] },
            },
          ],
        },
      ],
      permissions: [
        {
          role: "admin",
          object: "ticket",
          read: true,
          create: true,
          update: true,
          delete: true,
        },
        {
          role: "member",
          object: "ticket",
          read: true,
          create: true,
          update: true,
          delete: false,
        },
      ],
      pages: [
        {
          api_name: "overview",
          label: "Overview",
          nav_order: 0,
          definition: { blocks: [] },
        },
      ],
    },
  },
  {
    kind: "app_object_create",
    scope: "internal",
    description: "Add one object and its complete initial field set to an existing app.",
    default_mode: "ask",
    example: {
      app: "crm",
      object: {
        api_name: "contact",
        label: "Contact",
        plural_label: "Contacts",
        name_field: "full_name",
        visibility: "org",
        fields: [
          {
            api_name: "full_name",
            label: "Full name",
            kind: "text",
            required: true,
          },
          {
            api_name: "account",
            label: "Account",
            kind: "reference",
            reference_targets: ["account"],
          },
        ],
        layouts: [],
      },
    },
  },
  {
    kind: "app_field_add",
    scope: "internal",
    description:
      "Add one optional field to an existing object. Required fields need an additive backfill sequence.",
    default_mode: "ask",
    example: {
      app: "crm",
      object: "account",
      field: {
        api_name: "industry",
        label: "Industry",
        kind: "text",
        required: false,
      },
    },
  },
  {
    kind: "app_field_modify",
    scope: "internal",
    description:
      "Change field metadata such as label, required validation, read-only state, picklist values, or reference targets; types are permanent.",
    default_mode: "ask",
    example: {
      app: "crm",
      object: "opportunity",
      field: "stage",
      changes: { label: "Sales stage", picklist_values: ["new", "won", "lost"] },
    },
  },
  {
    kind: "app_object_archive",
    scope: "internal",
    description: "Hide an object without dropping its physical table or stored rows.",
    default_mode: "ask",
    example: { app: "crm", object: "legacy_note" },
  },
  {
    kind: "app_field_archive",
    scope: "internal",
    description: "Hide a field without dropping its physical column or stored values.",
    default_mode: "ask",
    example: { app: "crm", object: "account", field: "legacy_code" },
  },
  {
    kind: "app_permission_set",
    scope: "internal",
    description: "Set one admin/member object's CRUD grants and regenerate GraphJin policy.",
    default_mode: "ask",
    example: {
      app: "crm",
      role: "member",
      object: "account",
      read: true,
      create: false,
      update: false,
      delete: false,
    },
  },
  {
    kind: "app_layout_update",
    scope: "internal",
    description: "Update an object's detail/list layout or an app page definition.",
    default_mode: "ask",
    example: {
      app: "crm",
      object: "account",
      kind: "detail",
      definition: { sections: [{ fields: ["name", "industry"] }] },
    },
  },
] as const;

export type RecordSchemaPlannerSurface = {
  prepare(request: RecordSchemaActionRequest): Promise<PreparedRecordSchemaAction>;
};

export type RecordSchemaSagaSurface = {
  get(actionRequestId: string): Promise<RecordSchemaChange | null>;
  approve(actionRequestId: string, previewHash: string): Promise<RecordSchemaChange>;
  execute(actionRequestId: string): Promise<RecordSchemaChange>;
};

const TRANSIENT_SCHEMA_CODES = new Set([
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

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

function retryableSchemaError(error: unknown): boolean {
  if (error instanceof RecordsSchemaApprovalStaleError) return false;
  const code = errorCode(error);
  return code.startsWith("08") || TRANSIENT_SCHEMA_CODES.has(code);
}

function previewHash(request: ActionRequestRecord): string {
  const value = request.payload.preview_hash;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("records schema action is missing its approved preview hash");
  }
  return value;
}

export function createRecordSchemaPreflightHook(
  planner: RecordSchemaPlannerSurface,
  updatePayload: typeof updateActionRequestPayload = updateActionRequestPayload,
): ActionRequestCreatedHook {
  return async (request) => {
    if (!RECORD_SCHEMA_ACTION_KINDS.includes(request.kind as never)) return;
    const prepared = await planner.prepare({
      id: request.id,
      orgId: request.orgId,
      kind: request.kind,
      payload: request.payload,
      actorUserId: request.actorUserId,
      actorRole: request.actorRole,
    });
    return updatePayload({
      id: request.id,
      orgId: request.orgId,
      payload: prepared.payload,
    });
  };
}

export function createRecordSchemaActionAdapter(
  kind: (typeof RECORD_SCHEMA_ACTION_KINDS)[number],
  saga: RecordSchemaSagaSurface,
): ActionAdapter {
  return async ({ request }) => {
    if (request.kind !== kind) {
      throw new Error(`adapter ${kind} cannot execute action kind ${request.kind}`);
    }
    if (request.actorRole !== "admin") {
      throw new Error("records schema actions require an admin actor snapshot");
    }
    const hash = previewHash(request);
    try {
      let change = await saga.get(request.id);
      if (!change) {
        throw new Error(`records schema plan is missing for action request ${request.id}`);
      }
      if (change.previewHash !== hash) {
        throw new RecordsSchemaApprovalStaleError(
          "action request approval does not match its records schema plan",
        );
      }
      if (change.phase === "planned") {
        change = await saga.approve(request.id, hash);
      }
      if (!["approved", "applying", "applied", "projected"].includes(change.phase)) {
        throw new Error(`records schema change cannot resume from ${change.phase}`);
      }
      const result = await saga.execute(request.id);
      return {
        commandOrOperation: kind,
        externalRef: result.id,
        result: {
          appId: result.appId,
          desiredRevision: result.desiredRevision,
          previewHash: result.previewHash,
          phase: result.phase,
        },
      };
    } catch (error) {
      if (retryableSchemaError(error)) {
        throw new RetryableActionAdapterError(
          `records schema action ${request.id} is temporarily unavailable and will be retried`,
          { cause: error },
        );
      }
      throw error;
    }
  };
}

export function registerRecordSchemaActions(input: {
  planner: RecordSchemaPlannerSurface;
  saga: RecordSchemaSagaSurface;
  registerAdapter?: (kind: string, adapter: ActionAdapter) => void;
  registerPreflight?: (
    hook: ActionRequestCreatedHook,
  ) => () => void;
}): () => void {
  const registerAdapter = input.registerAdapter ?? registerActionAdapter;
  for (const kind of RECORD_SCHEMA_ACTION_KINDS) {
    registerAdapter(kind, createRecordSchemaActionAdapter(kind, input.saga));
  }
  return (input.registerPreflight ?? registerActionRequestCreatedHook)(
    createRecordSchemaPreflightHook(input.planner),
  );
}
