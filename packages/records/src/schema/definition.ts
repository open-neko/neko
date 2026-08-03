import type { Pool, PoolClient } from "pg";
import { recordIdentifier, recordTableName } from "../naming";
import { bumpRegistryRevision } from "../registry";
import {
  RECORD_FIELD_KINDS,
  type AppRegistrySnapshot,
  type JsonObject,
  type RecordFieldKind,
  type RecordIdentifier,
  type RecordLayoutKind,
  type RecordVisibility,
} from "../types";
import type { RecordDdlObjectDefinition } from "./ddl";
import { parseRecordAppPage } from "../app-page";

export type RecordAppFieldDefinition = {
  apiName: RecordIdentifier;
  sourceApiName: string | null;
  label: string;
  kind: RecordFieldKind;
  columnName: RecordIdentifier;
  required: boolean;
  readOnly: boolean;
  archived: boolean;
  picklistValues: string[] | null;
  referenceTargets: RecordIdentifier[] | null;
  length: number | null;
  scale: number | null;
};

export type RecordAppObjectDefinition = {
  apiName: RecordIdentifier;
  sourceApiName: string | null;
  label: string;
  pluralLabel: string;
  tableName: RecordIdentifier;
  nameField: RecordIdentifier;
  visibility: RecordVisibility;
  custom: boolean;
  archived: boolean;
  fields: RecordAppFieldDefinition[];
  layouts: Array<{ kind: RecordLayoutKind; definition: JsonObject }>;
};

export type RecordAppPermissionDefinition = {
  role: "admin" | "member";
  objectApiName: RecordIdentifier;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

export type RecordAppPageDefinition = {
  apiName: RecordIdentifier;
  label: string;
  definition: JsonObject;
  navOrder: number;
};

export type RecordAppDefinition = {
  appId: RecordIdentifier;
  label: string;
  purpose: string | null;
  navOrder: number;
  archived: boolean;
  objects: RecordAppObjectDefinition[];
  permissions: RecordAppPermissionDefinition[];
  pages: RecordAppPageDefinition[];
};

export class RecordSchemaDefinitionError extends Error {
  readonly code = "records_schema_definition_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordSchemaDefinitionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RecordSchemaDefinitionError(`${path}: object required`);
  return value;
}

function stringValue(
  value: unknown,
  path: string,
  options: { optional?: boolean; max?: number } = {},
): string | null {
  if (value === undefined || value === null) {
    if (options.optional) return null;
    throw new RecordSchemaDefinitionError(`${path}: non-empty string required`);
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new RecordSchemaDefinitionError(`${path}: non-empty string required`);
  }
  const result = value.trim();
  if (result.length > (options.max ?? 500)) {
    throw new RecordSchemaDefinitionError(`${path}: exceeds ${options.max ?? 500} characters`);
  }
  return result;
}

function booleanValue(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new RecordSchemaDefinitionError(`${path}: boolean required`);
  }
  return value;
}

function integerValue(
  value: unknown,
  fallback: number | null,
  path: string,
  minimum: number,
): number | null {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new RecordSchemaDefinitionError(`${path}: integer >= ${minimum} required`);
  }
  return Number(value);
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new RecordSchemaDefinitionError(`${path}: array required`);
  return value;
}

function assertUnique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new RecordSchemaDefinitionError(`${path}: duplicate API identifiers`);
  }
}

function identifierSource(value: Record<string, unknown>, path: string): string {
  return stringValue(
    value.api_name ?? value.name ?? value.label,
    `${path}.api_name`,
    { max: 500 },
  )!;
}

function stringList(value: unknown, path: string): string[] | null {
  if (value === undefined || value === null) return null;
  const result = arrayValue(value, path).map((item, index) =>
    stringValue(item, `${path}[${index}]`, { max: 500 })!,
  );
  if (new Set(result).size !== result.length) {
    throw new RecordSchemaDefinitionError(`${path}: duplicate values`);
  }
  return result;
}

function parseField(value: unknown, path: string): RecordAppFieldDefinition {
  const raw = objectValue(value, path);
  if ("type" in raw) {
    throw new RecordSchemaDefinitionError(
      `${path}.type: use the canonical field key "kind"`,
    );
  }
  if ("options" in raw) {
    throw new RecordSchemaDefinitionError(
      `${path}.options: use the canonical field key "picklist_values"`,
    );
  }
  const apiName = recordIdentifier(identifierSource(raw, path));
  const kind = raw.kind ?? "text";
  if (
    typeof kind !== "string" ||
    !RECORD_FIELD_KINDS.includes(kind as RecordFieldKind) ||
    kind === "id"
  ) {
    throw new RecordSchemaDefinitionError(`${path}.kind: unsupported field kind`);
  }
  const picklistValues = stringList(raw.picklist_values, `${path}.picklist_values`);
  const referenceTargets = stringList(
    raw.reference_targets,
    `${path}.reference_targets`,
  )?.map(recordIdentifier) ?? null;
  if (kind === "reference" && (!referenceTargets || referenceTargets.length === 0)) {
    throw new RecordSchemaDefinitionError(
      `${path}.reference_targets: reference fields require at least one target`,
    );
  }
  if ((kind === "picklist" || kind === "multipicklist") && !picklistValues) {
    throw new RecordSchemaDefinitionError(
      `${path}.picklist_values: picklist fields require an explicit value list`,
    );
  }
  const readOnly = booleanValue(raw.read_only, kind === "readonly_formula", `${path}.read_only`);
  return {
    apiName,
    sourceApiName: stringValue(raw.source_api_name, `${path}.source_api_name`, {
      optional: true,
      max: 500,
    }),
    columnName: apiName,
    label: stringValue(raw.label ?? raw.name ?? raw.api_name, `${path}.label`, {
      max: 200,
    })!,
    kind: kind as RecordFieldKind,
    required: booleanValue(raw.required, false, `${path}.required`),
    readOnly,
    archived: booleanValue(raw.archived, false, `${path}.archived`),
    picklistValues,
    referenceTargets,
    length: integerValue(raw.length, null, `${path}.length`, 1),
    scale: integerValue(raw.scale, null, `${path}.scale`, 0),
  };
}

function parseLayout(value: unknown, path: string): {
  kind: RecordLayoutKind;
  definition: JsonObject;
} {
  const raw = objectValue(value, path);
  if (raw.kind !== "detail" && raw.kind !== "list") {
    throw new RecordSchemaDefinitionError(`${path}.kind: detail or list required`);
  }
  return {
    kind: raw.kind,
    definition: { ...objectValue(raw.definition, `${path}.definition`) },
  };
}

function parseObject(
  appId: RecordIdentifier,
  value: unknown,
  path: string,
): RecordAppObjectDefinition {
  const raw = objectValue(value, path);
  const apiName = recordIdentifier(identifierSource(raw, path));
  const fields = arrayValue(raw.fields, `${path}.fields`).map((field, index) =>
    parseField(field, `${path}.fields[${index}]`),
  );
  if (fields.length === 0) {
    throw new RecordSchemaDefinitionError(`${path}.fields: at least one field required`);
  }
  assertUnique(fields.map((field) => field.apiName), `${path}.fields`);
  const requestedNameField =
    raw.name_field === undefined
      ? fields.find((field) => !field.archived)?.apiName
      : recordIdentifier(stringValue(raw.name_field, `${path}.name_field`)!);
  if (
    !requestedNameField ||
    !fields.some(
      (field) => field.apiName === requestedNameField && !field.archived,
    )
  ) {
    throw new RecordSchemaDefinitionError(`${path}.name_field: live field required`);
  }
  const visibility = raw.visibility ?? "org";
  if (visibility !== "org" && visibility !== "owner") {
    throw new RecordSchemaDefinitionError(`${path}.visibility: org or owner required`);
  }
  const label = stringValue(raw.label ?? raw.name ?? raw.api_name, `${path}.label`, {
    max: 200,
  })!;
  return {
    apiName,
    sourceApiName: stringValue(raw.source_api_name, `${path}.source_api_name`, {
      optional: true,
      max: 500,
    }),
    label,
    pluralLabel: stringValue(raw.plural_label ?? `${label}s`, `${path}.plural_label`, {
      max: 200,
    })!,
    tableName: recordTableName(appId, apiName),
    nameField: requestedNameField,
    visibility,
    custom: booleanValue(raw.custom, false, `${path}.custom`),
    archived: booleanValue(raw.archived, false, `${path}.archived`),
    fields,
    layouts:
      raw.layouts === undefined
        ? []
        : arrayValue(raw.layouts, `${path}.layouts`).map((layout, index) =>
            parseLayout(layout, `${path}.layouts[${index}]`),
          ),
  };
}

function defaultPermissions(
  objects: RecordAppObjectDefinition[],
): RecordAppPermissionDefinition[] {
  return objects.flatMap((object) => [
    {
      role: "admin" as const,
      objectApiName: object.apiName,
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    },
    {
      role: "member" as const,
      objectApiName: object.apiName,
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    },
  ]);
}

function parsePermission(
  value: unknown,
  path: string,
): RecordAppPermissionDefinition {
  const raw = objectValue(value, path);
  if (raw.role !== "admin" && raw.role !== "member") {
    throw new RecordSchemaDefinitionError(`${path}.role: admin or member required`);
  }
  return {
    role: raw.role,
    objectApiName: recordIdentifier(
      stringValue(raw.object, `${path}.object`, { max: 500 })!,
    ),
    canRead: booleanValue(raw.read, false, `${path}.read`),
    canCreate: booleanValue(raw.create, false, `${path}.create`),
    canUpdate: booleanValue(raw.update, false, `${path}.update`),
    canDelete: booleanValue(raw.delete, false, `${path}.delete`),
  };
}

function parsePage(value: unknown, path: string): RecordAppPageDefinition {
  const raw = objectValue(value, path);
  const page = parseRecordAppPage(objectValue(raw.definition, `${path}.definition`));
  return {
    apiName: recordIdentifier(identifierSource(raw, path)),
    label: stringValue(raw.label ?? raw.name ?? raw.api_name, `${path}.label`, {
      max: 200,
    })!,
    definition: { blocks: page.blocks },
    navOrder: integerValue(raw.nav_order, 0, `${path}.nav_order`, 0)!,
  };
}

/** Normalize a complete initial app proposal into permanent identifiers. */
export function parseRecordAppDefinition(value: unknown): RecordAppDefinition {
  const raw = objectValue(value, "payload");
  const appId = recordIdentifier(
    stringValue(raw.app ?? raw.api_name ?? raw.label, "payload.app", {
      max: 500,
    })!,
  );
  const objects = arrayValue(raw.objects, "payload.objects").map((object, index) =>
    parseObject(appId, object, `payload.objects[${index}]`),
  );
  if (objects.length === 0) {
    throw new RecordSchemaDefinitionError("payload.objects: at least one object required");
  }
  assertUnique(objects.map((object) => object.apiName), "payload.objects");
  const objectNames = new Set<string>(objects.map((object) => object.apiName));
  const liveObjectNames = new Set<string>(
    objects.filter((object) => !object.archived).map((object) => object.apiName),
  );
  for (const object of objects) {
    for (const field of object.fields) {
      for (const target of field.referenceTargets ?? []) {
        if (!objectNames.has(target)) {
          throw new RecordSchemaDefinitionError(
            `payload.objects.${object.apiName}.${field.apiName}: unknown reference target ${target}`,
          );
        }
        if (!field.archived && !liveObjectNames.has(target)) {
          throw new RecordSchemaDefinitionError(
            `payload.objects.${object.apiName}.${field.apiName}: live reference target required: ${target}`,
          );
        }
      }
    }
  }
  const permissions =
    raw.permissions === undefined
      ? defaultPermissions(objects)
      : arrayValue(raw.permissions, "payload.permissions").map((permission, index) =>
          parsePermission(permission, `payload.permissions[${index}]`),
        );
  for (const permission of permissions) {
    if (!objectNames.has(permission.objectApiName)) {
      throw new RecordSchemaDefinitionError(
        `payload.permissions: unknown object ${permission.objectApiName}`,
      );
    }
  }
  assertUnique(
    permissions.map((permission) => `${permission.role}\u0000${permission.objectApiName}`),
    "payload.permissions",
  );
  const pages =
    raw.pages === undefined
      ? []
      : arrayValue(raw.pages, "payload.pages").map((page, index) =>
          parsePage(page, `payload.pages[${index}]`),
        );
  assertUnique(pages.map((page) => page.apiName), "payload.pages");
  return {
    appId,
    label: stringValue(raw.label ?? raw.app ?? raw.api_name, "payload.label", {
      max: 200,
    })!,
    purpose: stringValue(raw.purpose, "payload.purpose", {
      optional: true,
      max: 2_000,
    }),
    navOrder: integerValue(raw.nav_order, 0, "payload.nav_order", 0)!,
    archived: false,
    objects,
    permissions,
    pages,
  };
}

/** Convert a persisted registry generation back into the saga's full desired model. */
export function recordAppDefinitionFromSnapshot(
  snapshot: AppRegistrySnapshot,
): RecordAppDefinition {
  return {
    appId: recordIdentifier(snapshot.app.appId),
    label: snapshot.app.label,
    purpose: snapshot.app.purpose,
    navOrder: snapshot.app.navOrder,
    archived: snapshot.app.status === "archived",
    objects: snapshot.objects.map((object) => ({
      apiName: object.apiName,
      sourceApiName: object.sourceApiName,
      label: object.label,
      pluralLabel: object.pluralLabel,
      tableName: object.tableName,
      nameField: object.nameField,
      visibility: object.visibility,
      custom: object.custom,
      archived: object.archivedAt !== null,
      fields: snapshot.fields
        .filter((field) => field.objectId === object.id)
        .map((field) => ({
          apiName: field.apiName,
          sourceApiName: field.sourceApiName,
          label: field.label,
          kind: field.kind,
          columnName: field.columnName,
          required: field.required,
          readOnly: field.readOnly,
          archived: field.archivedAt !== null,
          picklistValues: field.picklistValues as string[] | null,
          referenceTargets: field.referenceTargets?.map(recordIdentifier) ?? null,
          length: field.length,
          scale: field.scale,
        })),
      layouts: snapshot.layouts
        .filter((layout) => layout.objectId === object.id)
        .map((layout) => ({ kind: layout.kind, definition: layout.definition })),
    })),
    permissions: snapshot.permissions.map((permission) => ({
      role: permission.role as "admin" | "member",
      objectApiName: permission.objectApiName,
      canRead: permission.canRead,
      canCreate: permission.canCreate,
      canUpdate: permission.canUpdate,
      canDelete: permission.canDelete,
    })),
    pages: snapshot.pages.map((page) => ({
      apiName: page.apiName,
      label: page.label,
      definition: page.definition,
      navOrder: page.navOrder,
    })),
  };
}

export function recordAppDefinitionDdlObjects(
  definition: RecordAppDefinition,
): RecordDdlObjectDefinition[] {
  return definition.objects.map((object) => ({
    appId: definition.appId,
    apiName: object.apiName,
    tableName: object.tableName,
    nameField: object.nameField,
    visibility: object.visibility,
    archived: object.archived,
    fields: object.fields.map((field) => ({
      columnName: field.columnName,
      kind: field.kind,
      required: field.required,
      archived: field.archived,
      length: field.length,
      scale: field.scale,
    })),
  }));
}

async function transaction<T>(
  client: PoolClient,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query("begin");
  try {
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/** Idempotently project the approved full app definition into engine metadata. */
export async function projectRecordAppDefinition(
  pool: Pool,
  input: {
    orgId: string;
    definition: RecordAppDefinition;
    desiredRevision: string;
    /** Explicit owner entitlement for a newly created SSO/multi-user app. */
    creatorGrant?: { userId: string; actionRequestId: string };
  },
): Promise<string> {
  const client = await pool.connect();
  try {
    return await transaction(client, async () => {
      const objectIds = new Map<string, string>();
      const fieldIds = new Map<string, string>();
      const projectedApp = await client.query<{
        registry_revision: string;
      }>(
        `select registry_revision::text as registry_revision
         from engine.record_app
         where org_id = $1 and app_id = $2
         for update`,
        [input.orgId, input.definition.appId],
      );
      const projectedRevision = projectedApp.rows[0]?.registry_revision;
      if (
        projectedRevision !== undefined &&
        BigInt(projectedRevision) >= BigInt(input.desiredRevision)
      ) {
        await client.query(
          `update engine.record_app
           set status = $3, updated_at = now()
           where org_id = $1 and app_id = $2`,
          [
            input.orgId,
            input.definition.appId,
            input.definition.archived ? "archived" : "active",
          ],
        );
        return projectedRevision;
      }
      await client.query(
        `insert into engine.record_app
           (org_id, app_id, label, purpose, status, nav_order, registry_revision)
         values ($1, $2, $3, $4, 'provisioning', $5, 0)
         on conflict (org_id, app_id) do update
         set label = excluded.label, purpose = excluded.purpose,
             nav_order = excluded.nav_order, updated_at = now()`,
        [
          input.orgId,
          input.definition.appId,
          input.definition.label,
          input.definition.purpose,
          input.definition.navOrder,
        ],
      );
      for (const object of input.definition.objects) {
        const objectResult = await client.query<{ id: string }>(
          `insert into engine.record_object
             (org_id, app_id, api_name, source_api_name, label, plural_label, table_name,
              name_field, visibility, is_custom, archived_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   case when $11 then now() else null end)
           on conflict (org_id, app_id, api_name) do update
           set source_api_name = excluded.source_api_name,
               label = excluded.label, plural_label = excluded.plural_label,
               name_field = excluded.name_field, visibility = excluded.visibility,
               is_custom = excluded.is_custom,
               archived_at = excluded.archived_at, updated_at = now()
           returning id`,
          [
            input.orgId,
            input.definition.appId,
            object.apiName,
            object.sourceApiName,
            object.label,
            object.pluralLabel,
            object.tableName,
            object.nameField,
            object.visibility,
            object.custom,
            object.archived,
          ],
        );
        const objectId = objectResult.rows[0]?.id;
        if (!objectId) throw new Error(`records object projection failed: ${object.apiName}`);
        objectIds.set(object.apiName, objectId);
        for (const field of object.fields) {
          const fieldResult = await client.query<{ id: string }>(
            `insert into engine.record_field
               (org_id, object_id, api_name, source_api_name, label, kind, column_name,
                required, read_only, archived_at, picklist_values,
                reference_targets, length, scale)
             values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9,
                     case when $10 then now() else null end,
                     $11::jsonb, $12::jsonb, $13, $14)
             on conflict (object_id, api_name) do update
             set source_api_name = excluded.source_api_name,
                 label = excluded.label, required = excluded.required,
                 read_only = excluded.read_only, archived_at = excluded.archived_at,
                 picklist_values = excluded.picklist_values,
                 reference_targets = excluded.reference_targets,
                 length = excluded.length, scale = excluded.scale,
                 updated_at = now()
             returning id`,
            [
              input.orgId,
              objectId,
              field.apiName,
              field.sourceApiName,
              field.label,
              field.kind,
              field.columnName,
              field.required,
              field.readOnly,
              field.archived,
              field.picklistValues === null ? null : JSON.stringify(field.picklistValues),
              field.referenceTargets === null
                ? null
                : JSON.stringify(field.referenceTargets),
              field.length,
              field.scale,
            ],
          );
          const fieldId = fieldResult.rows[0]?.id;
          if (!fieldId) {
            throw new Error(
              `records field projection failed: ${object.apiName}.${field.apiName}`,
            );
          }
          fieldIds.set(`${object.apiName}\u0000${field.apiName}`, fieldId);
        }
        for (const layout of object.layouts) {
          await client.query(
            `insert into engine.record_layout (org_id, object_id, kind, definition)
             values ($1, $2::uuid, $3, $4::jsonb)
             on conflict (object_id, kind) do update
             set definition = excluded.definition, updated_at = now()`,
            [input.orgId, objectId, layout.kind, JSON.stringify(layout.definition)],
          );
        }
      }
      for (const object of input.definition.objects) {
        const fromObjectId = objectIds.get(object.apiName);
        if (!fromObjectId) continue;
        for (const field of object.fields) {
          const fromFieldId = fieldIds.get(`${object.apiName}\u0000${field.apiName}`);
          if (!fromFieldId) continue;
          await client.query(
            "delete from engine.record_relationship where from_field = $1::uuid",
            [fromFieldId],
          );
          if (field.archived || field.kind !== "reference") continue;
          for (const target of field.referenceTargets ?? []) {
            const toObjectId = objectIds.get(target);
            if (!toObjectId) {
              throw new Error(
                `records relationship projection target missing: ${object.apiName}.${field.apiName} -> ${target}`,
              );
            }
            await client.query(
              `insert into engine.record_relationship
                 (org_id, from_object, from_field, to_object, relationship_label)
               values ($1, $2::uuid, $3::uuid, $4::uuid, $5)
               on conflict (from_field, to_object) do update
               set relationship_label = excluded.relationship_label`,
              [
                input.orgId,
                fromObjectId,
                fromFieldId,
                toObjectId,
                field.label,
              ],
            );
          }
        }
      }
      for (const permission of input.definition.permissions) {
        await client.query(
          `insert into engine.record_permission
             (org_id, app_id, role, object_api_name,
              can_read, can_create, can_update, can_delete)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (org_id, app_id, role, object_api_name) do update
           set can_read = excluded.can_read, can_create = excluded.can_create,
               can_update = excluded.can_update, can_delete = excluded.can_delete,
               updated_at = now()`,
          [
            input.orgId,
            input.definition.appId,
            permission.role,
            permission.objectApiName,
            permission.canRead,
            permission.canCreate,
            permission.canUpdate,
            permission.canDelete,
          ],
        );
      }
      if (input.creatorGrant) {
        await client.query(
          `insert into engine.app_access_grant
             (org_id, app_id, subject_type, subject_id,
              created_by_user_id, action_request_id)
           values ($1, $2, 'user', $3, $3, $4)
           on conflict (org_id, app_id, subject_type, subject_id) do nothing`,
          [
            input.orgId,
            input.definition.appId,
            input.creatorGrant.userId,
            input.creatorGrant.actionRequestId,
          ],
        );
        for (const object of input.definition.objects.filter((item) => !item.archived)) {
          const ceiling = input.definition.permissions.find(
            (permission) =>
              permission.role === "admin" &&
              permission.objectApiName === object.apiName,
          );
          if (!ceiling || !ceiling.canRead) continue;
          await client.query(
            `insert into engine.object_access_grant
               (org_id, app_id, subject_type, subject_id, object_api_name,
                can_read, can_create, can_update, can_delete,
                created_by_user_id, action_request_id)
             values ($1, $2, 'user', $3, $4, $5, $6, $7, $8, $3, $9)
             on conflict
               (org_id, app_id, subject_type, subject_id, object_api_name)
             do update set
               can_read = excluded.can_read,
               can_create = excluded.can_create,
               can_update = excluded.can_update,
               can_delete = excluded.can_delete,
               updated_at = now()`,
            [
              input.orgId,
              input.definition.appId,
              input.creatorGrant.userId,
              object.apiName,
              ceiling.canRead,
              ceiling.canCreate,
              ceiling.canUpdate,
              ceiling.canDelete,
              input.creatorGrant.actionRequestId,
            ],
          );
          for (const field of object.fields.filter((item) => !item.archived)) {
            const fieldId = fieldIds.get(`${object.apiName}\u0000${field.apiName}`);
            if (!fieldId) continue;
            await client.query(
              `insert into engine.field_access_grant
                 (org_id, app_id, subject_type, subject_id, object_api_name,
                  field_id, can_read, can_write,
                  created_by_user_id, action_request_id)
               values ($1, $2, 'user', $3, $4, $5::uuid, true, $6, $3, $7)
               on conflict (org_id, app_id, subject_type, subject_id, field_id)
               do update set
                 can_read = excluded.can_read,
                 can_write = excluded.can_write,
                 updated_at = now()`,
              [
                input.orgId,
                input.definition.appId,
                input.creatorGrant.userId,
                object.apiName,
                fieldId,
                (ceiling.canCreate || ceiling.canUpdate) && !field.readOnly,
                input.creatorGrant.actionRequestId,
              ],
            );
          }
        }
        await client.query(
          `insert into engine.entitlement_audit
             (org_id, app_id, subject_type, subject_id, resource_kind,
              resource_id, operation, after_value, actor_user_id,
              action_request_id)
           values ($1, $2, 'user', $3, 'app', $2, 'grant',
                   jsonb_build_object('owner', true), $3, $4)`,
          [
            input.orgId,
            input.definition.appId,
            input.creatorGrant.userId,
            input.creatorGrant.actionRequestId,
          ],
        );
      }
      for (const page of input.definition.pages) {
        await client.query(
          `insert into engine.app_page
             (org_id, app_id, api_name, label, definition, nav_order)
           values ($1, $2, $3, $4, $5::jsonb, $6)
           on conflict (org_id, app_id, api_name) do update
           set label = excluded.label, definition = excluded.definition,
               nav_order = excluded.nav_order, updated_at = now()`,
          [
            input.orgId,
            input.definition.appId,
            page.apiName,
            page.label,
            JSON.stringify(page.definition),
            page.navOrder,
          ],
        );
      }
      await client.query(
        `insert into engine.actor (org_id, user_id, role)
         values ($1, 'records-service', 'service')
         on conflict (org_id, user_id) do update
         set role = 'service', disabled_at = null, synced_at = now()`,
        [input.orgId],
      );
      const revision = await bumpRegistryRevision(client, input.orgId);
      if (BigInt(revision) < BigInt(input.desiredRevision)) {
        throw new Error("registry revision did not reach the approved desired revision");
      }
      await client.query(
        `update engine.record_app
         set status = $3, registry_revision = $4::bigint, updated_at = now()
         where org_id = $1 and app_id = $2`,
        [
          input.orgId,
          input.definition.appId,
          input.definition.archived ? "archived" : "active",
          revision,
        ],
      );
      return revision;
    });
  } finally {
    client.release();
  }
}
