import type { Pool, PoolClient } from "pg";
import { validateRecordIdentifier } from "./naming";
import type {
  AppPage,
  AppRegistrySnapshot,
  JsonObject,
  RecordApp,
  RecordAppStatus,
  RecordField,
  RecordFieldKind,
  RecordLayout,
  RecordLayoutKind,
  RecordObject,
  RecordPermission,
  RecordVisibility,
} from "./types";

type RawApp = {
  org_id: string;
  app_id: string;
  label: string;
  purpose: string | null;
  status: RecordAppStatus;
  nav_order: number;
  registry_revision: string;
};

type RawObject = {
  id: string;
  org_id: string;
  app_id: string;
  api_name: string;
  source_api_name: string | null;
  label: string;
  plural_label: string;
  table_schema: string;
  table_name: string;
  name_field: string;
  visibility: RecordVisibility;
  is_custom: boolean;
  archived_at: Date | null;
  record_count: string | null;
};

type RawField = {
  id: string;
  org_id: string;
  object_id: string;
  api_name: string;
  source_api_name: string | null;
  label: string;
  kind: RecordFieldKind;
  column_name: string;
  required: boolean;
  read_only: boolean;
  archived_at: Date | null;
  picklist_values: unknown[] | null;
  reference_targets: string[] | null;
  length: number | null;
  scale: number | null;
};

type RawLayout = {
  object_id: string;
  kind: RecordLayoutKind;
  definition: JsonObject;
};

type RawPage = {
  id: string;
  api_name: string;
  label: string;
  definition: JsonObject;
  nav_order: number;
};

type RawPermission = {
  app_id: string;
  role: string;
  object_api_name: string;
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
  can_delete: boolean;
};

type CacheEntry = {
  revision: string;
  snapshot: AppRegistrySnapshot | null;
};

function cacheKey(orgId: string, appId: string): string {
  return `${orgId}\u0000${appId}`;
}

async function currentRevision(client: Pool | PoolClient, orgId: string): Promise<string> {
  const result = await client.query<{ revision: string }>(
    "select revision::text as revision from engine.registry_version where org_id = $1",
    [orgId],
  );
  return result.rows[0]?.revision ?? "0";
}

function mapApp(row: RawApp): RecordApp {
  return {
    orgId: row.org_id,
    appId: row.app_id,
    label: row.label,
    purpose: row.purpose,
    status: row.status,
    navOrder: row.nav_order,
    registryRevision: row.registry_revision,
  };
}

function mapObject(row: RawObject): RecordObject {
  return {
    id: row.id,
    orgId: row.org_id,
    appId: row.app_id,
    apiName: validateRecordIdentifier(row.api_name),
    sourceApiName: row.source_api_name,
    label: row.label,
    pluralLabel: row.plural_label,
    tableSchema: validateRecordIdentifier(row.table_schema),
    tableName: validateRecordIdentifier(row.table_name),
    nameField: validateRecordIdentifier(row.name_field),
    visibility: row.visibility,
    custom: row.is_custom,
    archivedAt: row.archived_at,
    recordCount: row.record_count,
  };
}

function mapField(row: RawField): RecordField {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    apiName: validateRecordIdentifier(row.api_name),
    sourceApiName: row.source_api_name,
    label: row.label,
    kind: row.kind,
    columnName: validateRecordIdentifier(row.column_name),
    required: row.required,
    readOnly: row.read_only,
    archivedAt: row.archived_at,
    picklistValues: row.picklist_values,
    referenceTargets: row.reference_targets,
    length: row.length,
    scale: row.scale,
  };
}

/**
 * Typed, revision-aware registry reader. Every cache hit first checks the
 * org-level revision; changed revisions reload a repeatable-read snapshot so
 * web and worker processes cannot observe mixed registry generations.
 */
export class RecordRegistry {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly pool: Pool) {}

  async listApps(orgId: string): Promise<RecordApp[]> {
    const result = await this.pool.query<RawApp>(
      `select org_id, app_id, label, purpose, status, nav_order,
              registry_revision::text as registry_revision
       from engine.record_app
       where org_id = $1
         and status in ('importing', 'active', 'degraded')
       order by nav_order, label, app_id`,
      [orgId],
    );
    return result.rows.map(mapApp);
  }

  async loadApp(orgId: string, appId: string): Promise<AppRegistrySnapshot | null> {
    const key = cacheKey(orgId, appId);
    const observedRevision = await currentRevision(this.pool, orgId);
    const cached = this.cache.get(key);
    if (cached?.revision === observedRevision) return cached.snapshot;

    const client = await this.pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const revision = await currentRevision(client, orgId);
      const appResult = await client.query<RawApp>(
        `select org_id, app_id, label, purpose, status, nav_order,
                registry_revision::text as registry_revision
         from engine.record_app where org_id = $1 and app_id = $2`,
        [orgId, appId],
      );
      const appRow = appResult.rows[0];
      if (!appRow) {
        await client.query("commit");
        this.cache.set(key, { revision, snapshot: null });
        return null;
      }

      // A pg client has one wire protocol stream. Keep these reads sequential
      // inside the repeatable-read transaction; concurrent client.query calls
      // are deprecated in pg 8 and become an error in pg 9.
      const objectsResult = await client.query<RawObject>(
        `select id, org_id, app_id, api_name, source_api_name, label,
                plural_label, table_schema, table_name, name_field,
                visibility, is_custom, archived_at, record_count::text
         from engine.record_object
         where org_id = $1 and app_id = $2
         order by label, api_name`,
        [orgId, appId],
      );
      const fieldsResult = await client.query<RawField>(
        `select f.id, f.org_id, f.object_id, f.api_name, f.source_api_name,
                f.label, f.kind, f.column_name, f.required, f.read_only,
                f.archived_at, f.picklist_values, f.reference_targets,
                f.length, f.scale
         from engine.record_field f
         join engine.record_object o on o.id = f.object_id and o.org_id = f.org_id
         where o.org_id = $1 and o.app_id = $2
         order by f.object_id, f.created_at, f.api_name`,
        [orgId, appId],
      );
      const layoutsResult = await client.query<RawLayout>(
        `select l.object_id, l.kind, l.definition
         from engine.record_layout l
         join engine.record_object o on o.id = l.object_id and o.org_id = l.org_id
         where o.org_id = $1 and o.app_id = $2
         order by l.object_id, l.kind`,
        [orgId, appId],
      );
      const pagesResult = await client.query<RawPage>(
        `select id, api_name, label, definition, nav_order
         from engine.app_page
         where org_id = $1 and app_id = $2
         order by nav_order, label, api_name`,
        [orgId, appId],
      );
      const permissionsResult = await client.query<RawPermission>(
        `select app_id, role, object_api_name, can_read, can_create, can_update, can_delete
         from engine.record_permission
         where org_id = $1 and app_id = $2
         order by role, object_api_name`,
        [orgId, appId],
      );

      const snapshot: AppRegistrySnapshot = {
        revision,
        app: mapApp(appRow),
        objects: objectsResult.rows.map(mapObject),
        fields: fieldsResult.rows.map(mapField),
        layouts: layoutsResult.rows.map((row): RecordLayout => ({
          objectId: row.object_id,
          kind: row.kind,
          definition: row.definition,
        })),
        pages: pagesResult.rows.map((row): AppPage => ({
          id: row.id,
          apiName: validateRecordIdentifier(row.api_name),
          label: row.label,
          definition: row.definition,
          navOrder: row.nav_order,
        })),
        permissions: permissionsResult.rows.map((row): RecordPermission => ({
          appId: row.app_id,
          role: row.role,
          objectApiName: validateRecordIdentifier(row.object_api_name),
          canRead: row.can_read,
          canCreate: row.can_create,
          canUpdate: row.can_update,
          canDelete: row.can_delete,
        })),
      };
      await client.query("commit");
      this.cache.set(key, { revision, snapshot });
      return snapshot;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  invalidate(orgId: string, appId?: string): void {
    if (appId !== undefined) {
      this.cache.delete(cacheKey(orgId, appId));
      return;
    }
    const prefix = `${orgId}\u0000`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}

/** Single-writer helper used by the schema executor after registry projection. */
export async function bumpRegistryRevision(
  client: Pool | PoolClient,
  orgId: string,
): Promise<string> {
  const result = await client.query<{ revision: string }>(
    `insert into engine.registry_version (org_id, revision)
     values ($1, 1)
     on conflict (org_id) do update
       set revision = engine.registry_version.revision + 1,
           updated_at = now()
     returning revision::text as revision`,
    [orgId],
  );
  const revision = result.rows[0]?.revision;
  if (!revision) throw new Error("registry revision bump returned no row");
  return revision;
}
