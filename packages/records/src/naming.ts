import { createHash } from "node:crypto";
import type { RecordIdentifier } from "./types";

export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

const CUSTOM_FIELD_SUFFIX = "__c";
const HASH_HEX_LENGTH = 10;
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

// PostgreSQL keywords plus common GraphQL/GraphJin structural names. We keep
// this deliberately conservative: generated names are a permanent API, so a
// harmless suffix now is cheaper than a compatibility migration later.
const RESERVED_IDENTIFIERS = new Set([
  "all",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "authorization",
  "between",
  "bigint",
  "binary",
  "boolean",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "cross",
  "current_catalog",
  "current_date",
  "current_role",
  "current_schema",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "exists",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "inner",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "natural",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "outer",
  "overlaps",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "verbose",
  "when",
  "where",
  "window",
  "with",
]);

export class InvalidRecordNameError extends Error {
  constructor(readonly sourceName: string) {
    super("record names must contain at least one ASCII letter or digit");
    this.name = "InvalidRecordNameError";
  }
}

function stableHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, HASH_HEX_LENGTH);
}

function canonicalize(sourceName: string): string {
  if (typeof sourceName !== "string") {
    throw new InvalidRecordNameError(String(sourceName));
  }

  let name = sourceName
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (!/[a-z0-9]/.test(name)) {
    throw new InvalidRecordNameError(sourceName);
  }
  if (/^[0-9]/.test(name)) {
    name = `n_${name}`;
  }
  if (RESERVED_IDENTIFIERS.has(name)) {
    name = `${name}_nk`;
  }
  return name;
}

function truncateAscii(input: string, maxBytes: number): string {
  // canonicalize() emits ASCII only, so code-unit and UTF-8 byte lengths are
  // identical. Keeping this helper explicit documents the Postgres contract.
  return input.slice(0, maxBytes);
}

function finalizeIdentifier(canonical: string, hashSource: string): RecordIdentifier {
  if (Buffer.byteLength(canonical, "utf8") <= POSTGRES_IDENTIFIER_MAX_BYTES) {
    return canonical as RecordIdentifier;
  }

  const customSuffix = canonical.endsWith(CUSTOM_FIELD_SUFFIX)
    ? CUSTOM_FIELD_SUFFIX
    : "";
  const stem = customSuffix ? canonical.slice(0, -CUSTOM_FIELD_SUFFIX.length) : canonical;
  const suffix = `_${stableHash(hashSource)}${customSuffix}`;
  const maxStemBytes = POSTGRES_IDENTIFIER_MAX_BYTES - Buffer.byteLength(suffix, "utf8");
  const truncatedStem = truncateAscii(stem, maxStemBytes).replace(/_+$/g, "");
  return `${truncatedStem}${suffix}` as RecordIdentifier;
}

/** Convert an app/object/field source name into its permanent API identifier. */
export function recordIdentifier(sourceName: string): RecordIdentifier {
  return finalizeIdentifier(canonicalize(sourceName), sourceName);
}

/** Build the `<app>__<object>` physical table name mandated by the registry. */
export function recordTableName(appId: string, objectApiName: string): RecordIdentifier {
  const canonical = `${canonicalize(appId)}__${canonicalize(objectApiName)}`;
  return finalizeIdentifier(canonical, `${appId}\u0000${objectApiName}`);
}

/**
 * Quote an already-safe identifier for catalog inspection and generated SQL
 * previews. GraphJin still owns schema application; this is not a raw-name
 * escape hatch.
 */
export function quoteRecordIdentifier(identifier: RecordIdentifier): string {
  if (
    !SAFE_IDENTIFIER.test(identifier) ||
    Buffer.byteLength(identifier, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES
  ) {
    throw new InvalidRecordNameError(identifier);
  }
  return `"${identifier}"`;
}
