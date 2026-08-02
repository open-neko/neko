import { recordIdentifier, validateRecordIdentifier } from "../naming";
import { RECORD_SYSTEM_COLUMNS } from "../policy/graphjin";
import type {
  RecordFieldKind,
  RecordIdentifier,
  RecordVisibility,
} from "../types";

export type RecordDdlFieldDefinition = {
  columnName: RecordIdentifier;
  kind: RecordFieldKind;
  required: boolean;
  archived?: boolean;
  length?: number | null;
  scale?: number | null;
};

export type RecordDdlObjectDefinition = {
  appId: string;
  apiName: RecordIdentifier;
  tableName: RecordIdentifier;
  nameField: RecordIdentifier;
  visibility: RecordVisibility;
  archived?: boolean;
  fields: RecordDdlFieldDefinition[];
};

const RESERVED_COLUMNS = new Set<string>([
  "id",
  RECORD_SYSTEM_COLUMNS.orgId,
  RECORD_SYSTEM_COLUMNS.ownerUserId,
  RECORD_SYSTEM_COLUMNS.createdAt,
  RECORD_SYSTEM_COLUMNS.createdBy,
  RECORD_SYSTEM_COLUMNS.updatedAt,
  RECORD_SYSTEM_COLUMNS.updatedBy,
  RECORD_SYSTEM_COLUMNS.actionRequestId,
  RECORD_SYSTEM_COLUMNS.mutationId,
  RECORD_SYSTEM_COLUMNS.deletedAt,
]);

function positiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function graphjinType(field: RecordDdlFieldDefinition): {
  type: string;
  typeDirective?: string;
} {
  const length = positiveInteger(field.length, `${field.columnName} length`);
  const scale = nonNegativeInteger(field.scale, `${field.columnName} scale`);
  switch (field.kind) {
    case "boolean":
      return { type: "Boolean" };
    case "integer":
      return { type: "BigInt" };
    case "decimal":
    case "currency":
    case "percent": {
      const resolvedScale = scale ?? (field.kind === "currency" ? 2 : null);
      if (resolvedScale === null) return { type: "Numeric" };
      const precision = length ?? 38;
      if (resolvedScale > precision) {
        throw new Error(`${field.columnName} scale cannot exceed precision`);
      }
      return {
        type: "Numeric",
        typeDirective: `@type(args: ${JSON.stringify(`${precision}, ${resolvedScale}`)})`,
      };
    }
    case "date":
      return { type: "Date" };
    case "datetime":
      return { type: "Timestamptz" };
    case "multipicklist":
      return { type: "Jsonb" };
    case "id":
    case "text":
    case "textarea":
    case "email":
    case "phone":
    case "url":
    case "picklist":
    case "reference":
    case "readonly_formula":
      return { type: "Text" };
  }
}

function indexDirective(tableName: RecordIdentifier, columnName: RecordIdentifier): string {
  const indexName = recordIdentifier(`idx_${tableName}_${columnName}`);
  return `@index(name: ${JSON.stringify(indexName)})`;
}

function fieldLine(
  object: RecordDdlObjectDefinition,
  field: RecordDdlFieldDefinition,
): string {
  const columnName = validateRecordIdentifier(field.columnName);
  if (field.kind === "id") {
    if (columnName !== "id") {
      throw new Error(`id field on ${object.tableName} must use the id column`);
    }
    return "  id: Text! @id";
  }
  if (RESERVED_COLUMNS.has(columnName)) {
    throw new Error(`field ${object.tableName}.${columnName} uses a records system column`);
  }

  const mapped = graphjinType(field);
  const directives: string[] = [];
  if (mapped.typeDirective) directives.push(mapped.typeDirective);
  if (columnName === object.nameField || field.kind === "reference") {
    directives.push(indexDirective(object.tableName, columnName));
  }
  return `  ${columnName}: ${mapped.type}${field.required ? "!" : ""}${
    directives.length > 0 ? ` ${directives.join(" ")}` : ""
  }`;
}

function objectBlock(object: RecordDdlObjectDefinition): string {
  const apiName = validateRecordIdentifier(object.apiName);
  const tableName = validateRecordIdentifier(object.tableName);
  const nameField = validateRecordIdentifier(object.nameField);
  if (!object.appId.trim()) throw new Error(`records DDL object ${apiName} requires an app id`);

  const liveFields = object.fields.filter((field) => !field.archived);
  const seenColumns = new Set<string>();
  for (const field of liveFields) {
    const columnName = validateRecordIdentifier(field.columnName);
    if (field.kind === "id" && columnName !== "id") {
      throw new Error(`id field on ${tableName} must use the id column`);
    }
    if (field.kind !== "id" && RESERVED_COLUMNS.has(columnName)) {
      throw new Error(`field ${tableName}.${columnName} uses a records system column`);
    }
    if (seenColumns.has(columnName)) {
      throw new Error(`duplicate records DDL field: ${tableName}.${columnName}`);
    }
    seenColumns.add(columnName);
  }
  if (nameField !== "id" && !liveFields.some((field) => field.columnName === nameField)) {
    throw new Error(`records DDL name field is missing: ${tableName}.${nameField}`);
  }

  const userFields = liveFields
    .filter((field) => field.kind !== "id")
    .sort((left, right) => left.columnName.localeCompare(right.columnName))
    .map((field) => fieldLine(object, field));
  const ownerField =
    object.visibility === "owner"
      ? [`  ${RECORD_SYSTEM_COLUMNS.ownerUserId}: Text!`]
      : [];

  return [
    `type ${tableName} {`,
    "  id: Text! @id",
    `  ${RECORD_SYSTEM_COLUMNS.orgId}: Text!`,
    ...ownerField,
    ...userFields,
    `  ${RECORD_SYSTEM_COLUMNS.createdAt}: Timestamptz!`,
    `  ${RECORD_SYSTEM_COLUMNS.createdBy}: Text!`,
    `  ${RECORD_SYSTEM_COLUMNS.updatedAt}: Timestamptz!`,
    `  ${RECORD_SYSTEM_COLUMNS.updatedBy}: Text!`,
    `  ${RECORD_SYSTEM_COLUMNS.actionRequestId}: Text!`,
    `  ${RECORD_SYSTEM_COLUMNS.mutationId}: Text!`,
    `  ${RECORD_SYSTEM_COLUMNS.deletedAt}: Timestamptz`,
    "}",
  ].join("\n");
}

/** Project the full desired registry shape into GraphJin's additive DDL. */
export function buildRecordsGraphjinDdl(objects: RecordDdlObjectDefinition[]): string {
  const liveObjects = objects
    .filter((object) => !object.archived)
    .sort((left, right) => left.tableName.localeCompare(right.tableName));
  const seenTables = new Set<string>();
  for (const object of liveObjects) {
    const tableName = validateRecordIdentifier(object.tableName);
    if (seenTables.has(tableName)) {
      throw new Error(`duplicate records DDL table: ${tableName}`);
    }
    seenTables.add(tableName);
  }
  if (liveObjects.length === 0) {
    throw new Error("records GraphJin DDL requires at least one live object");
  }
  return `${liveObjects.map(objectBlock).join("\n\n")}\n`;
}
