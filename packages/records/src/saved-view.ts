import type { Pool } from "pg";
import { validateRecordIdentifier } from "./naming";
import {
  buildRecordListQuery,
  type RecordFilterExpression,
  type RecordFilterOperator,
  type RecordViewerRole,
} from "./read/query";
import { RecordRegistry } from "./registry";
import type { AppRegistrySnapshot } from "./types";

const FILTER_OPERATORS = new Set<RecordFilterOperator>([
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "is_null",
  "gt",
  "gte",
  "lt",
  "lte",
  "relative",
  "is_open",
  "is_closed",
]);

export type RecordSavedViewDefinition = {
  version: 1;
  filter: RecordFilterExpression | null;
  sort: { field: string; direction: "asc" | "desc" } | null;
  search: string | null;
  myRecords: boolean;
  columns: string[];
};

export type RecordSavedView = {
  id: string;
  label: string;
  ownerUserId: string | null;
  shared: boolean;
  definition: RecordSavedViewDefinition;
  createdAt: string;
  updatedAt: string;
};

export class RecordSavedViewError extends Error {
  readonly code = "records_saved_view_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordSavedViewError";
  }
}

export class RecordSavedViewPermissionError extends Error {
  readonly code = "records_saved_view_permission_denied";

  constructor(message = "saved view access is not allowed") {
    super(message);
    this.name = "RecordSavedViewPermissionError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecordSavedViewError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeExpression(
  value: unknown,
  budget = { count: 0 },
  depth = 0,
): RecordFilterExpression {
  budget.count += 1;
  if (budget.count > 50 || depth > 5) {
    throw new RecordSavedViewError("saved view filter is too complex");
  }
  const candidate = object(value, "saved view filter");
  if ("op" in candidate) {
    if (candidate.op !== "and" && candidate.op !== "or") {
      throw new RecordSavedViewError("saved view filter group is invalid");
    }
    if (
      !Array.isArray(candidate.clauses) ||
      candidate.clauses.length < 1 ||
      candidate.clauses.length > 20
    ) {
      throw new RecordSavedViewError(
        "saved view filter groups require 1 to 20 clauses",
      );
    }
    return {
      op: candidate.op,
      clauses: candidate.clauses.map((clause) =>
        normalizeExpression(clause, budget, depth + 1),
      ),
    };
  }
  if (typeof candidate.field !== "string") {
    throw new RecordSavedViewError("saved view filter field is required");
  }
  let field: string;
  try {
    field = validateRecordIdentifier(candidate.field);
  } catch {
    throw new RecordSavedViewError("saved view filter field is invalid");
  }
  if (
    typeof candidate.operator !== "string" ||
    !FILTER_OPERATORS.has(candidate.operator as RecordFilterOperator)
  ) {
    throw new RecordSavedViewError("saved view filter operator is invalid");
  }
  return {
    field,
    operator: candidate.operator as RecordFilterOperator,
    ...(Object.hasOwn(candidate, "value") ? { value: candidate.value } : {}),
  };
}

export function normalizeRecordSavedViewDefinition(
  value: unknown,
): RecordSavedViewDefinition {
  const candidate = object(value, "saved view definition");
  if (candidate.version !== 1) {
    throw new RecordSavedViewError("saved view definition version must be 1");
  }
  const search = candidate.search;
  if (
    search !== null &&
    search !== undefined &&
    (typeof search !== "string" || search.length > 200)
  ) {
    throw new RecordSavedViewError("saved view search is invalid");
  }
  const myRecords = candidate.myRecords ?? false;
  if (typeof myRecords !== "boolean") {
    throw new RecordSavedViewError("saved view ownership scope is invalid");
  }
  const rawColumns = candidate.columns ?? [];
  if (!Array.isArray(rawColumns) || rawColumns.length > 50) {
    throw new RecordSavedViewError("saved view columns are invalid");
  }
  const columns = rawColumns.map((column) => {
    if (typeof column !== "string") {
      throw new RecordSavedViewError("saved view column is invalid");
    }
    try {
      return validateRecordIdentifier(column);
    } catch {
      throw new RecordSavedViewError("saved view column is invalid");
    }
  });
  const rawSort = candidate.sort;
  let sort: RecordSavedViewDefinition["sort"] = null;
  if (rawSort !== null && rawSort !== undefined) {
    const parsed = object(rawSort, "saved view sort");
    if (
      typeof parsed.field !== "string" ||
      (parsed.direction !== "asc" && parsed.direction !== "desc")
    ) {
      throw new RecordSavedViewError("saved view sort is invalid");
    }
    try {
      sort = {
        field: validateRecordIdentifier(parsed.field),
        direction: parsed.direction,
      };
    } catch {
      throw new RecordSavedViewError("saved view sort field is invalid");
    }
  }
  return {
    version: 1,
    filter:
      candidate.filter === null || candidate.filter === undefined
        ? null
        : normalizeExpression(candidate.filter),
    sort,
    search: typeof search === "string" && search.trim() ? search.trim() : null,
    myRecords,
    columns: [...new Set(columns)],
  };
}

type RawSavedView = {
  id: string;
  label: string;
  owner_user_id: string | null;
  shared: boolean;
  definition: unknown;
  created_at: Date;
  updated_at: Date;
};

function mapView(row: RawSavedView): RecordSavedView {
  return {
    id: row.id,
    label: row.label,
    ownerUserId: row.owner_user_id,
    shared: row.shared,
    definition: normalizeRecordSavedViewDefinition(row.definition),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function labelValue(value: string): string {
  const label = value.trim();
  if (!label || label.length > 80) {
    throw new RecordSavedViewError("saved view label must be 1 to 80 characters");
  }
  return label;
}

function readableObject(
  snapshot: AppRegistrySnapshot,
  objectApiName: string,
  role: RecordViewerRole,
) {
  let canonical: string;
  try {
    canonical = validateRecordIdentifier(objectApiName);
  } catch {
    throw new RecordSavedViewError("saved view object is invalid");
  }
  const recordObject = snapshot.objects.find(
    (candidate) => candidate.apiName === canonical && candidate.archivedAt === null,
  );
  const permission = snapshot.permissions.find(
    (candidate) =>
      candidate.objectApiName === canonical &&
      candidate.role === role &&
      candidate.canRead,
  );
  if (!recordObject || !permission) throw new RecordSavedViewPermissionError();
  return recordObject;
}

export class RecordSavedViewStore {
  private readonly registry: RecordRegistry;

  constructor(private readonly pool: Pool, registry?: RecordRegistry) {
    this.registry = registry ?? new RecordRegistry(pool);
  }

  private async context(input: {
    orgId: string;
    appId: string;
    objectApiName: string;
    role: RecordViewerRole;
  }) {
    const snapshot = await this.registry.loadApp(input.orgId, input.appId);
    if (!snapshot || snapshot.app.status !== "active") {
      throw new RecordSavedViewPermissionError();
    }
    return {
      snapshot,
      object: readableObject(snapshot, input.objectApiName, input.role),
    };
  }

  async list(input: {
    orgId: string;
    appId: string;
    objectApiName: string;
    userId: string;
    role: RecordViewerRole;
  }): Promise<RecordSavedView[]> {
    const { object: recordObject } = await this.context(input);
    const result = await this.pool.query<RawSavedView>(
      `select id, label, owner_user_id, shared, definition, created_at, updated_at
       from engine.saved_view
       where org_id = $1 and object_id = $2::uuid
         and ((owner_user_id = $3 and shared = false)
              or (owner_user_id is null and shared = true))
       order by shared, lower(label), id`,
      [input.orgId, recordObject.id, input.userId],
    );
    return result.rows.map(mapView);
  }

  async save(input: {
    orgId: string;
    appId: string;
    objectApiName: string;
    userId: string;
    role: RecordViewerRole;
    label: string;
    shared: boolean;
    definition: unknown;
  }): Promise<RecordSavedView> {
    if (input.shared && input.role !== "admin") {
      throw new RecordSavedViewPermissionError(
        "only admins can share an org-wide saved view",
      );
    }
    const { snapshot, object: recordObject } = await this.context(input);
    const definition = normalizeRecordSavedViewDefinition(input.definition);
    buildRecordListQuery({
      snapshot,
      objectApiName: recordObject.apiName,
      role: input.role,
      userId: input.userId,
      first: 1,
      filter: definition.filter,
      sort: definition.sort ?? undefined,
      search: definition.search,
      myRecords: definition.myRecords,
      columns: definition.columns.length > 0 ? definition.columns : undefined,
    });
    const ownerUserId = input.shared ? null : input.userId;
    const result = await this.pool.query<RawSavedView>(
      `insert into engine.saved_view
         (org_id, object_id, owner_user_id, label, definition, shared)
       values ($1, $2::uuid, $3, $4, $5::jsonb, $6)
       on conflict (org_id, object_id, owner_user_id, label) do update
       set definition = excluded.definition, shared = excluded.shared, updated_at = now()
       returning id, label, owner_user_id, shared, definition, created_at, updated_at`,
      [
        input.orgId,
        recordObject.id,
        ownerUserId,
        labelValue(input.label),
        JSON.stringify(definition),
        input.shared,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("saved view write did not return a row");
    return mapView(row);
  }

  async remove(input: {
    orgId: string;
    appId: string;
    objectApiName: string;
    userId: string;
    role: RecordViewerRole;
    id: string;
  }): Promise<boolean> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id)) {
      throw new RecordSavedViewError("saved view id is invalid");
    }
    const { object: recordObject } = await this.context(input);
    const result = await this.pool.query(
      `delete from engine.saved_view
       where id = $1::uuid and org_id = $2 and object_id = $3::uuid
         and ((owner_user_id = $4 and shared = false)
              or ($5 = 'admin' and owner_user_id is null and shared = true))`,
      [input.id, input.orgId, recordObject.id, input.userId, input.role],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
