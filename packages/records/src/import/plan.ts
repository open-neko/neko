import { createHash } from "node:crypto";
import { basename, posix } from "node:path";
import { recordIdentifier, validateRecordIdentifier } from "../naming";
import type {
  AppRegistrySnapshot,
  RecordField,
  RecordFieldKind,
  RecordObject,
} from "../types";
import { parseRecordsCsv } from "./csv";

const SAMPLE_LIMIT = 10_000;
const PREVIEW_LIMIT = 5;
const TEXT_KINDS = new Set<RecordFieldKind>([
  "id",
  "text",
  "textarea",
  "email",
  "phone",
  "url",
  "picklist",
  "reference",
  "readonly_formula",
]);

export type RecordImportColumnPlan = {
  sourceColumn: string;
  targetField: string | null;
  targetKind: RecordFieldKind | null;
  inferredKind: Exclude<RecordFieldKind, "id" | "reference" | "readonly_formula">;
  emptyText: boolean;
  suggestedField: {
    apiName: string;
    label: string;
    kind: Exclude<RecordFieldKind, "id" | "reference" | "readonly_formula">;
  } | null;
};

export type RecordImportPlan = {
  version: 1;
  appId: string;
  objectApiName: string;
  tableName: string;
  source: {
    path: string;
    name: string;
    sha256: string;
    bytes: number;
  };
  rowCount: number;
  sampleRows: Array<Record<string, string>>;
  columns: RecordImportColumnPlan[];
  duplicateKey: string;
  batchSize: number;
  ownerUserId: string | null;
  warnings: string[];
  planHash: string;
};

export class RecordImportPlanError extends Error {
  readonly code = "records_import_plan_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordImportPlanError";
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RecordImportPlanError("CSV must be valid UTF-8");
  }
}

export function normalizeRecordImportSourcePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new RecordImportPlanError("import source must be a workspace-relative path");
  }
  const clean = posix.normalize(normalized);
  if (
    clean === "." ||
    clean.startsWith("../") ||
    (!clean.startsWith("uploads/") && !clean.startsWith("imports/"))
  ) {
    throw new RecordImportPlanError(
      "import source must be staged below uploads/ or imports/",
    );
  }
  return clean;
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isDatetime(value: string): boolean {
  if (!/[T ]\d{2}:\d{2}/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function inferRecordImportFieldKind(
  values: readonly string[],
): Exclude<RecordFieldKind, "id" | "reference" | "readonly_formula"> {
  const populated = values.map((value) => value.trim()).filter(Boolean);
  if (populated.length === 0) return "text";
  if (populated.every((value) => /^(?:true|false|yes|no)$/i.test(value))) {
    return "boolean";
  }
  if (populated.every((value) => /^-?(?:0|[1-9]\d*)$/.test(value))) {
    return "integer";
  }
  if (populated.every((value) => /^-?(?:0|[1-9]\d*)\.\d+$/.test(value))) {
    return "decimal";
  }
  if (populated.every(isRealDate)) return "date";
  if (populated.every(isDatetime)) return "datetime";
  if (populated.every(isEmail)) return "email";
  if (populated.every(isUrl)) return "url";
  if (populated.some((value) => value.includes("\n") || value.length > 500)) {
    return "textarea";
  }
  return "text";
}

function liveObject(snapshot: AppRegistrySnapshot, objectApiName: string): RecordObject {
  const canonical = validateRecordIdentifier(objectApiName);
  const object = snapshot.objects.find(
    (candidate) => candidate.apiName === canonical && candidate.archivedAt === null,
  );
  if (!object) throw new RecordImportPlanError("import object is unknown or archived");
  return object;
}

function liveWritableFields(
  snapshot: AppRegistrySnapshot,
  object: RecordObject,
): RecordField[] {
  return snapshot.fields.filter(
    (field) =>
      field.objectId === object.id &&
      field.archivedAt === null &&
      !field.readOnly,
  );
}

function normalizedMatch(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function automaticTarget(header: string, fields: RecordField[]): string | null {
  const exact = normalizedMatch(header);
  if (exact === "id") return "id";
  const direct = fields.filter((field) =>
    [field.apiName, field.sourceApiName, field.label]
      .filter((candidate): candidate is string => Boolean(candidate))
      .some((candidate) => normalizedMatch(candidate) === exact),
  );
  if (direct.length === 1) return direct[0]!.apiName;
  const identifier = recordIdentifier(header);
  const identifierMatches = fields.filter((field) => field.apiName === identifier);
  return identifierMatches.length === 1 ? identifierMatches[0]!.apiName : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function planHash(plan: Omit<RecordImportPlan, "planHash">): string {
  return createHash("sha256")
    .update(
      canonicalJson({ format: "openneko.records.csv-import.v1", ...plan }),
      "utf8",
    )
    .digest("hex");
}

export function verifyRecordImportPlanHash(plan: RecordImportPlan): void {
  const { planHash: expected, ...unsigned } = plan;
  const actual = planHash(unsigned);
  if (expected !== actual) {
    throw new RecordImportPlanError("import plan changed after approval");
  }
}

/** Build the human-reviewable mapping bound to the eventual import action. */
export function buildRecordImportPlan(input: {
  snapshot: AppRegistrySnapshot;
  objectApiName: string;
  sourcePath: string;
  sourceName: string;
  bytes: Uint8Array;
  mapping?: Record<string, string | null>;
  emptyTextColumns?: string[];
  duplicateKey?: string;
  batchSize?: number;
  ownerUserId?: string | null;
}): RecordImportPlan {
  if (input.snapshot.app.status !== "active") {
    throw new RecordImportPlanError("import app must be active");
  }
  const object = liveObject(input.snapshot, input.objectApiName);
  const fields = liveWritableFields(input.snapshot, object);
  const parsed = parseRecordsCsv(decodeUtf8(input.bytes));
  if (parsed.rows.length === 0) {
    throw new RecordImportPlanError("CSV must contain at least one data row");
  }
  const mapping = input.mapping ?? {};
  const unknownMappedHeaders = Object.keys(mapping).filter(
    (header) => !parsed.headers.includes(header),
  );
  if (unknownMappedHeaders.length > 0) {
    throw new RecordImportPlanError(
      `mapping references unknown CSV columns: ${unknownMappedHeaders.sort().join(", ")}`,
    );
  }
  const fieldByName = new Map(fields.map((field) => [field.apiName as string, field]));
  const emptyText = new Set(input.emptyTextColumns ?? []);
  const usedTargets = new Set<string>();
  const warnings: string[] = [];
  const columns = parsed.headers.map((header, columnIndex): RecordImportColumnPlan => {
    const inferredKind = inferRecordImportFieldKind(
      parsed.rows.slice(0, SAMPLE_LIMIT).map((row) => row.values[columnIndex] ?? ""),
    );
    const requested = Object.prototype.hasOwnProperty.call(mapping, header)
      ? mapping[header]
      : automaticTarget(header, fields);
    const targetField = requested === null || requested === undefined
      ? null
      : validateRecordIdentifier(requested);
    const target = targetField === "id" ? null : targetField ? fieldByName.get(targetField) : null;
    if (targetField && targetField !== "id" && !target) {
      throw new RecordImportPlanError(`${header}: mapped field is unknown or read-only`);
    }
    if (targetField && usedTargets.has(targetField)) {
      throw new RecordImportPlanError(`${header}: more than one CSV column maps to ${targetField}`);
    }
    if (targetField) usedTargets.add(targetField);
    if (emptyText.has(header) && (!target || !TEXT_KINDS.has(target.kind))) {
      throw new RecordImportPlanError(`${header}: empty-string preservation requires a text field`);
    }
    const suggestedApiName = recordIdentifier(header);
    if (!targetField) warnings.push(`${header} is not mapped and will be ignored`);
    return {
      sourceColumn: header,
      targetField,
      targetKind: targetField === "id" ? "id" : target?.kind ?? null,
      inferredKind,
      emptyText: emptyText.has(header),
      suggestedField: targetField
        ? null
        : { apiName: suggestedApiName, label: header, kind: inferredKind },
    };
  });

  for (const field of fields) {
    if (field.required && !usedTargets.has(field.apiName)) {
      throw new RecordImportPlanError(
        `required field ${field.apiName} has no CSV mapping`,
      );
    }
  }
  const duplicateKey = validateRecordIdentifier(input.duplicateKey ?? "id");
  if (duplicateKey !== "id" && !usedTargets.has(duplicateKey)) {
    throw new RecordImportPlanError("duplicate key must be id or a mapped field");
  }
  const batchSize = input.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new RecordImportPlanError("import batch size must be between 1 and 500");
  }
  const sourcePath = normalizeRecordImportSourcePath(input.sourcePath);
  const sourceName = basename(input.sourceName.trim());
  if (!sourceName || sourceName !== input.sourceName.trim()) {
    throw new RecordImportPlanError("import source name must be a plain filename");
  }
  const sampleRows = parsed.rows.slice(0, PREVIEW_LIMIT).map((row) =>
    Object.fromEntries(parsed.headers.map((header, index) => [header, row.values[index] ?? ""])),
  );
  const unsigned: Omit<RecordImportPlan, "planHash"> = {
    version: 1,
    appId: input.snapshot.app.appId,
    objectApiName: object.apiName,
    tableName: object.tableName,
    source: {
      path: sourcePath,
      name: sourceName,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      bytes: input.bytes.byteLength,
    },
    rowCount: parsed.rows.length,
    sampleRows,
    columns,
    duplicateKey,
    batchSize,
    ownerUserId: input.ownerUserId?.trim() || null,
    warnings,
  };
  return { ...unsigned, planHash: planHash(unsigned) };
}
