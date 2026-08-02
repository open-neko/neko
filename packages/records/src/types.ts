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

export const RECORD_FIELD_KINDS = [
  "id",
  "text",
  "textarea",
  "boolean",
  "integer",
  "decimal",
  "currency",
  "percent",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "picklist",
  "multipicklist",
  "reference",
  "readonly_formula",
] as const;

export type RecordFieldKind = (typeof RECORD_FIELD_KINDS)[number];
export type RecordVisibility = "org" | "owner";
export type RecordLayoutKind = "detail" | "list";
export type JsonObject = Record<string, unknown>;

export type RecordApp = {
  orgId: string;
  appId: string;
  label: string;
  purpose: string | null;
  status: RecordAppStatus;
  navOrder: number;
  registryRevision: string;
};

export type RecordObject = {
  id: string;
  orgId: string;
  appId: string;
  apiName: RecordIdentifier;
  sourceApiName: string | null;
  label: string;
  pluralLabel: string;
  tableSchema: RecordIdentifier;
  tableName: RecordIdentifier;
  nameField: RecordIdentifier;
  visibility: RecordVisibility;
  custom: boolean;
  archivedAt: Date | null;
  recordCount: string | null;
};

export type RecordField = {
  id: string;
  orgId: string;
  objectId: string;
  apiName: RecordIdentifier;
  sourceApiName: string | null;
  label: string;
  kind: RecordFieldKind;
  columnName: RecordIdentifier;
  required: boolean;
  readOnly: boolean;
  archivedAt: Date | null;
  picklistValues: unknown[] | null;
  referenceTargets: string[] | null;
  length: number | null;
  scale: number | null;
};

export type RecordLayout = {
  objectId: string;
  kind: RecordLayoutKind;
  definition: JsonObject;
};

export type RecordRelationship = {
  id: string;
  fromObjectId: string;
  fromFieldId: string;
  toObjectId: string;
  label: string | null;
};

export type AppPage = {
  id: string;
  apiName: RecordIdentifier;
  label: string;
  definition: JsonObject;
  navOrder: number;
};

export type RecordPermission = {
  appId: string;
  role: string;
  objectApiName: RecordIdentifier;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

export type AppRegistrySnapshot = {
  revision: string;
  app: RecordApp;
  objects: RecordObject[];
  fields: RecordField[];
  layouts: RecordLayout[];
  relationships?: RecordRelationship[];
  pages: AppPage[];
  permissions: RecordPermission[];
};
