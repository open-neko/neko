import { validateRecordIdentifier } from "./naming";
import {
  normalizeRecordSavedViewDefinition,
  RecordSavedViewError,
} from "./saved-view";
import type {
  RecordFilterExpression,
  RecordListFilter,
} from "./read/query";

export type RecordAppPageSort = {
  field: string;
  direction: "asc" | "desc";
};

export type RecordAppPageBlock = {
  label: string;
  renderer: "metric" | "list" | "timeline";
  span: 1 | 2 | 3;
  query: {
    object: string;
    filter: RecordFilterExpression | null;
    sort: RecordAppPageSort | null;
    limit: number;
    aggregate: "count" | "sum" | null;
    field: string | null;
  };
};

export type ParsedRecordAppPage = {
  blocks: RecordAppPageBlock[];
};

export class RecordAppPageDefinitionError extends Error {
  readonly code = "records_app_page_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordAppPageDefinitionError";
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RecordAppPageDefinitionError(`${path}: object required`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new RecordAppPageDefinitionError(`${path}: record identifier required`);
  }
  try {
    return validateRecordIdentifier(value);
  } catch {
    throw new RecordAppPageDefinitionError(`${path}: invalid record identifier`);
  }
}

function label(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new RecordAppPageDefinitionError(`${path}: 1 to 120 characters required`);
  }
  return value.trim();
}

function filterFromWhere(value: unknown, path: string): RecordFilterExpression | null {
  if (value === null || value === undefined) return null;
  const where = object(value, path);
  const clauses: RecordListFilter[] = [];
  for (const [field, rawCondition] of Object.entries(where)) {
    const condition = object(rawCondition, `${path}.${field}`);
    const entries = Object.entries(condition);
    if (entries.length !== 1) {
      throw new RecordAppPageDefinitionError(
        `${path}.${field}: exactly one semantic operator required`,
      );
    }
    const [operator, filterValue] = entries[0]!;
    clauses.push({
      field: identifier(field, `${path}.${field}`),
      operator: operator as RecordListFilter["operator"],
      ...(filterValue === undefined ? {} : { value: filterValue }),
    });
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0]! : { op: "and", clauses };
}

function normalizedFilter(value: unknown, path: string): RecordFilterExpression | null {
  try {
    return normalizeRecordSavedViewDefinition({
      version: 1,
      filter: value,
      sort: null,
      search: null,
      myRecords: false,
      columns: [],
    }).filter;
  } catch (error) {
    if (error instanceof RecordSavedViewError) {
      throw new RecordAppPageDefinitionError(`${path}: ${error.message}`);
    }
    throw error;
  }
}

function parseBlock(value: unknown, index: number): RecordAppPageBlock {
  const path = `app_page.blocks[${index}]`;
  const raw = object(value, path);
  if (raw.renderer !== "metric" && raw.renderer !== "list" && raw.renderer !== "timeline") {
    throw new RecordAppPageDefinitionError(
      `${path}.renderer: metric, list, or timeline required`,
    );
  }
  const query = object(raw.query, `${path}.query`);
  const aggregate = query.aggregate ?? null;
  if (aggregate !== null && aggregate !== "count" && aggregate !== "sum") {
    throw new RecordAppPageDefinitionError(`${path}.query.aggregate: count or sum required`);
  }
  if (raw.renderer === "metric" && aggregate === null) {
    throw new RecordAppPageDefinitionError(`${path}: metric blocks require an aggregate`);
  }
  if (raw.renderer !== "metric" && aggregate !== null) {
    throw new RecordAppPageDefinitionError(`${path}: only metric blocks can aggregate`);
  }
  const field = query.field === undefined || query.field === null
    ? null
    : identifier(query.field, `${path}.query.field`);
  if (aggregate === "sum" && field === null) {
    throw new RecordAppPageDefinitionError(`${path}: sum metrics require a field`);
  }
  if (aggregate !== "sum" && field !== null) {
    throw new RecordAppPageDefinitionError(`${path}: field is only valid for sum metrics`);
  }
  let sort: RecordAppPageSort | null = null;
  if (query.sort !== undefined && query.sort !== null) {
    const rawSort = query.sort;
    const authored = Array.isArray(rawSort);
    if (Array.isArray(rawSort) && rawSort.length > 1) {
      throw new RecordAppPageDefinitionError(`${path}.query.sort: at most one sort required`);
    }
    if (!Array.isArray(rawSort) || rawSort.length === 1) {
      const item = object(
        Array.isArray(rawSort) ? rawSort[0] : rawSort,
        authored ? `${path}.query.sort[0]` : `${path}.query.sort`,
      );
      if (item.direction !== "asc" && item.direction !== "desc") {
        throw new RecordAppPageDefinitionError(`${path}.query.sort.direction: asc or desc required`);
      }
      sort = {
        field: identifier(item.field, `${path}.query.sort.field`),
        direction: item.direction,
      };
    }
  }
  const limit = query.limit ?? (raw.renderer === "metric" ? 1 : 10);
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) {
    throw new RecordAppPageDefinitionError(`${path}.query.limit: 1 to 100 required`);
  }
  const span = raw.span ?? 1;
  if (span !== 1 && span !== 2 && span !== 3) {
    throw new RecordAppPageDefinitionError(`${path}.span: 1, 2, or 3 required`);
  }
  if (query.view !== undefined) {
    throw new RecordAppPageDefinitionError(
      `${path}.query.view: use a semantic filter instead of a view name`,
    );
  }
  const filter = query.filter !== undefined
    ? normalizedFilter(query.filter, `${path}.query.filter`)
    : filterFromWhere(query.where, `${path}.query.where`);
  return {
    label: label(raw.label, `${path}.label`),
    renderer: raw.renderer,
    span,
    query: {
      object: identifier(query.object, `${path}.query.object`),
      filter: filter === null ? null : normalizedFilter(filter, `${path}.query.filter`),
      sort,
      limit: Number(limit),
      aggregate,
      field,
    },
  };
}

/** Parse the closed-set D15 page contract; unknown executable query text is never accepted. */
export function parseRecordAppPage(value: unknown): ParsedRecordAppPage {
  const raw = object(value, "app_page");
  if (!Array.isArray(raw.blocks) || raw.blocks.length > 30) {
    throw new RecordAppPageDefinitionError("app_page.blocks: array of at most 30 blocks required");
  }
  return { blocks: raw.blocks.map(parseBlock) };
}
