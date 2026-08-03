import type { Pool, PoolClient } from "pg";
import type { AppRegistrySnapshot, JsonObject, RecordPermission } from "../types";
import type { RecordHumanRole } from "./evaluate";

export type RecordAccessActor = {
  userId: string;
  role: RecordHumanRole;
  /** Immutable IdP group IDs currently assigned to the user. */
  groupIds?: readonly string[];
  /** Synthetic local operator. This is the only entitlement bypass. */
  solo?: boolean;
};

export type EffectiveObjectAccess = {
  objectApiName: string;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

export type EffectiveFieldAccess = {
  fieldId: string;
  canRead: boolean;
  canWrite: boolean;
};

export type EffectiveRecordAccess = {
  app: boolean;
  objects: EffectiveObjectAccess[];
  fields: EffectiveFieldAccess[];
};

type AppGrantRow = { granted: boolean };
type ObjectGrantRow = {
  object_api_name: string;
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
  can_delete: boolean;
};
type FieldGrantRow = {
  field_id: string;
  can_read: boolean;
  can_write: boolean;
};

const SUBJECT_MATCH = `(
  (subject_type = 'user' and subject_id = $3)
  or (subject_type = 'group' and subject_id = any($4::text[]))
  or (subject_type = 'role' and subject_id = $5)
)`;

function isSoloOperator(actor: RecordAccessActor, orgId: string): boolean {
  if (!actor.solo) return false;
  if (
    actor.role !== "admin" ||
    actor.userId !== `urn:openneko:solo-admin:${orgId}`
  ) {
    throw new Error("records solo bypass requires the synthetic local admin");
  }
  return true;
}

/** Resolve current grants without caching so revocations take effect immediately. */
export async function loadEffectiveRecordAccess(
  client: Pool | PoolClient,
  input: { orgId: string; appId: string; actor: RecordAccessActor },
): Promise<EffectiveRecordAccess> {
  if (isSoloOperator(input.actor, input.orgId)) {
    return { app: true, objects: [], fields: [] };
  }
  const params = [
    input.orgId,
    input.appId,
    input.actor.userId,
    [...new Set(input.actor.groupIds ?? [])],
    input.actor.role,
  ];
  const app = await client.query<AppGrantRow>(
    `select exists(
       select 1 from engine.app_access_grant
       where org_id = $1 and app_id = $2 and ${SUBJECT_MATCH}
     ) as granted`,
    params,
  );
  if (!app.rows[0]?.granted) return { app: false, objects: [], fields: [] };

  const objects = await client.query<ObjectGrantRow>(
    `select object_api_name,
            bool_or(can_read) as can_read,
            bool_or(can_create) as can_create,
            bool_or(can_update) as can_update,
            bool_or(can_delete) as can_delete
     from engine.object_access_grant
     where org_id = $1 and app_id = $2 and ${SUBJECT_MATCH}
     group by object_api_name
     order by object_api_name`,
    params,
  );
  const fields = await client.query<FieldGrantRow>(
    `select field_id::text as field_id,
            bool_or(can_read) as can_read,
            bool_or(can_write) as can_write
     from engine.field_access_grant
     where org_id = $1 and app_id = $2 and ${SUBJECT_MATCH}
     group by field_id
     order by field_id`,
    params,
  );
  return {
    app: true,
    objects: objects.rows.map((row) => ({
      objectApiName: row.object_api_name,
      canRead: row.can_read,
      canCreate: row.can_create,
      canUpdate: row.can_update,
      canDelete: row.can_delete,
    })),
    fields: fields.rows.map((row) => ({
      fieldId: row.field_id,
      canRead: row.can_read,
      canWrite: row.can_write,
    })),
  };
}

function filteredLayoutDefinition(
  definition: JsonObject,
  allowed: ReadonlySet<string>,
): JsonObject {
  const keepField = (value: unknown): boolean => {
    if (typeof value === "string") return allowed.has(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    const field = typeof item.field === "string"
      ? item.field
      : typeof item.api_name === "string"
        ? item.api_name
        : null;
    return field !== null && allowed.has(field);
  };
  const next: JsonObject = { ...definition };
  if (Array.isArray(definition.columns)) {
    next.columns = definition.columns.filter(keepField);
  }
  if (Array.isArray(definition.fields)) {
    next.fields = definition.fields.filter(keepField);
  }
  if (Array.isArray(definition.sections)) {
    next.sections = definition.sections.map((section) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) return section;
      const item = section as JsonObject;
      return Array.isArray(item.fields)
        ? { ...item, fields: item.fields.filter(keepField) }
        : item;
    });
  }
  return next;
}

/**
 * Project the registry through one actor's effective grants. The legacy role
 * permission is a maximum; subject entitlements can narrow it but never widen
 * it. Solo mode deliberately receives a full projection.
 */
export function projectEffectiveRecordAccess(input: {
  snapshot: AppRegistrySnapshot;
  actor: RecordAccessActor;
  access: EffectiveRecordAccess;
}): AppRegistrySnapshot | null {
  const { snapshot, actor, access } = input;
  if (!access.app) return null;
  const solo = isSoloOperator(actor, snapshot.app.orgId);
  const entitlementByObject = new Map(
    access.objects.map((grant) => [grant.objectApiName, grant]),
  );
  const fieldAccess = new Map(access.fields.map((grant) => [grant.fieldId, grant]));
  const permissions: RecordPermission[] = [];

  for (const object of snapshot.objects) {
    const ceiling = snapshot.permissions.find(
      (grant) =>
        grant.role === actor.role &&
        grant.appId === snapshot.app.appId &&
        grant.objectApiName === object.apiName,
    );
    const grant = entitlementByObject.get(object.apiName);
    const full = solo;
    if (!full && (!ceiling || !grant)) continue;
    permissions.push({
      appId: snapshot.app.appId,
      role: actor.role,
      objectApiName: object.apiName,
      canRead: full || Boolean(ceiling?.canRead && grant?.canRead),
      canCreate: full || Boolean(ceiling?.canCreate && grant?.canCreate),
      canUpdate: full || Boolean(ceiling?.canUpdate && grant?.canUpdate),
      canDelete: full || Boolean(ceiling?.canDelete && grant?.canDelete),
    });
  }

  const readableObjectIds = new Set(
    snapshot.objects
      .filter((object) =>
        permissions.some(
          (grant) => grant.objectApiName === object.apiName && grant.canRead,
        ),
      )
      .map((object) => object.id),
  );
  const fields = snapshot.fields
    .filter((field) => {
      if (!readableObjectIds.has(field.objectId)) return false;
      return solo || fieldAccess.get(field.id)?.canRead === true;
    })
    .map((field) => {
      const object = snapshot.objects.find((candidate) => candidate.id === field.objectId);
      const permission = permissions.find(
        (candidate) => candidate.objectApiName === object?.apiName,
      );
      const fieldGrant = fieldAccess.get(field.id);
      const objectWritable = Boolean(permission?.canCreate || permission?.canUpdate);
      return {
        ...field,
        readOnly:
          field.readOnly ||
          (!solo && !(fieldGrant?.canWrite && objectWritable)),
      };
    });
  const allowedFieldNamesByObject = new Map<string, Set<string>>();
  for (const field of fields) {
    const allowed = allowedFieldNamesByObject.get(field.objectId) ?? new Set<string>();
    allowed.add(field.apiName);
    allowedFieldNamesByObject.set(field.objectId, allowed);
  }

  return {
    ...snapshot,
    objects: snapshot.objects.filter((object) => readableObjectIds.has(object.id)),
    fields,
    permissions,
    layouts: snapshot.layouts
      .filter((layout) => readableObjectIds.has(layout.objectId))
      .map((layout) => ({
        ...layout,
        definition: filteredLayoutDefinition(
          layout.definition,
          allowedFieldNamesByObject.get(layout.objectId) ?? new Set(),
        ),
      })),
    relationships: (snapshot.relationships ?? []).filter((relationship) =>
      fields.some((field) => field.id === relationship.fromFieldId),
    ),
  };
}

export async function authorizeRecordSnapshot(
  client: Pool | PoolClient,
  snapshot: AppRegistrySnapshot,
  actor: RecordAccessActor,
): Promise<AppRegistrySnapshot | null> {
  const access = isSoloOperator(actor, snapshot.app.orgId)
    ? { app: true, objects: [], fields: [] }
    : await loadEffectiveRecordAccess(client, {
        orgId: snapshot.app.orgId,
        appId: snapshot.app.appId,
        actor,
      });
  return projectEffectiveRecordAccess({ snapshot, actor, access });
}

export async function loadEntitlementRevision(
  client: Pool | PoolClient,
  orgId: string,
): Promise<string> {
  const result = await client.query<{ revision: string }>(
    `select revision::text as revision
     from engine.entitlement_revision where org_id = $1`,
    [orgId],
  );
  return result.rows[0]?.revision ?? "0";
}
