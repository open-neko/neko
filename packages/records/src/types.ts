declare const recordIdentifierBrand: unique symbol;

/**
 * A Postgres-safe, GraphJin-safe physical identifier produced by naming.ts.
 * Code outside this package cannot construct one without an explicit unsafe
 * cast, keeping raw model/import/user strings out of schema operations.
 */
export type RecordIdentifier = string & {
  readonly [recordIdentifierBrand]: "RecordIdentifier";
};

export const RECORD_APP_STATUSES = [
  "draft",
  "provisioning",
  "importing",
  "active",
  "degraded",
  "archived",
] as const;

export type RecordAppStatus = (typeof RECORD_APP_STATUSES)[number];
