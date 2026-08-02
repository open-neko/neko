import { createHash } from "node:crypto";
import { recordIdentifier } from "../../naming";
import {
  parseRecordAppDefinition,
  type RecordAppDefinition,
} from "../../schema/definition";
import type { RecordFieldKind, RecordIdentifier } from "../../types";
import type { RecordConnectorMode } from "../types";

export type SalesforcePicklistValue = {
  value: string;
  active?: boolean;
};

export type SalesforceFieldDescribe = {
  name: string;
  label: string;
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  calculated?: boolean;
  defaultedOnCreate?: boolean;
  nameField?: boolean;
  compoundFieldName?: string | null;
  referenceTo?: string[];
  picklistValues?: SalesforcePicklistValue[];
};

export type SalesforceObjectDescribe = {
  name: string;
  label: string;
  labelPlural: string;
  custom?: boolean;
  queryable?: boolean;
  replicateable?: boolean;
  fields: SalesforceFieldDescribe[];
};

export type SalesforceFieldMapping = {
  sourceField: string;
  targetField: RecordIdentifier | "id" | null;
  skippedReason: string | null;
};

export type SalesforceObjectMapping = {
  sourceObject: string;
  targetObject: RecordIdentifier;
  fields: SalesforceFieldMapping[];
};

export type SalesforceSchemaPlan = {
  definition: RecordAppDefinition;
  mappings: SalesforceObjectMapping[];
  warnings: string[];
};

export const SALESFORCE_SCHEMA_REVIEW_FORMAT =
  "openneko.records.salesforce-schema-review.v1" as const;

/** Complete, credential-free migration plan bound to the export approval. */
export type SalesforceSchemaReview = {
  format: typeof SALESFORCE_SCHEMA_REVIEW_FORMAT;
  sourceInstanceId: string;
  mode: RecordConnectorMode;
  plan: SalesforceSchemaPlan;
  planHash: string;
};

export class SalesforceSchemaApprovalStaleError extends Error {
  readonly code = "salesforce_schema_approval_stale";

  constructor(message = "Salesforce schema changed after approval") {
    super(message);
    this.name = "SalesforceSchemaApprovalStaleError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

/** Hash every reviewed object, field, source mapping, warning, and mode. */
export function salesforceSchemaPlanHash(input: {
  sourceInstanceId: string;
  mode: RecordConnectorMode;
  plan: SalesforceSchemaPlan;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        format: SALESFORCE_SCHEMA_REVIEW_FORMAT,
        sourceInstanceId: input.sourceInstanceId,
        mode: input.mode,
        plan: input.plan,
      }),
      "utf8",
    )
    .digest("hex");
}

export function createSalesforceSchemaReview(input: {
  sourceInstanceId: string;
  mode: RecordConnectorMode;
  plan: SalesforceSchemaPlan;
}): SalesforceSchemaReview {
  if (!input.sourceInstanceId.trim()) {
    throw new SalesforceSchemaApprovalStaleError(
      "Salesforce schema review is missing its source instance",
    );
  }
  return {
    format: SALESFORCE_SCHEMA_REVIEW_FORMAT,
    sourceInstanceId: input.sourceInstanceId,
    mode: input.mode,
    plan: input.plan,
    planHash: salesforceSchemaPlanHash(input),
  };
}

/** Validate a persisted review before it authorizes export or import work. */
export function verifySalesforceSchemaReview(
  value: unknown,
): asserts value is SalesforceSchemaReview {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SalesforceSchemaApprovalStaleError(
      "Salesforce export is missing its reviewed schema",
    );
  }
  const review = value as Partial<SalesforceSchemaReview>;
  if (
    review.format !== SALESFORCE_SCHEMA_REVIEW_FORMAT ||
    typeof review.sourceInstanceId !== "string" ||
    !review.sourceInstanceId.trim() ||
    (review.mode !== "mirror" && review.mode !== "primary") ||
    typeof review.plan !== "object" ||
    review.plan === null ||
    !Array.isArray(review.plan.mappings) ||
    !Array.isArray(review.plan.warnings) ||
    typeof review.plan.definition !== "object" ||
    review.plan.definition === null ||
    typeof review.planHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(review.planHash)
  ) {
    throw new SalesforceSchemaApprovalStaleError(
      "Salesforce schema review is incomplete",
    );
  }
  const actual = salesforceSchemaPlanHash({
    sourceInstanceId: review.sourceInstanceId,
    mode: review.mode,
    plan: review.plan,
  });
  if (actual !== review.planHash) {
    throw new SalesforceSchemaApprovalStaleError(
      "Salesforce schema review changed after approval",
    );
  }
}

export function assertSalesforceSchemaMatchesReview(
  plan: SalesforceSchemaPlan,
  review: SalesforceSchemaReview,
): void {
  verifySalesforceSchemaReview(review);
  const actual = salesforceSchemaPlanHash({
    sourceInstanceId: review.sourceInstanceId,
    mode: review.mode,
    plan,
  });
  if (actual !== review.planHash) {
    throw new SalesforceSchemaApprovalStaleError();
  }
}

export class SalesforceDescribeError extends Error {
  readonly code = "salesforce_describe_invalid";

  constructor(message: string) {
    super(message);
    this.name = "SalesforceDescribeError";
  }
}

function describeRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SalesforceDescribeError(`${path}: object required`);
  }
  return value as Record<string, unknown>;
}

function describeString(
  value: unknown,
  path: string,
  maximum = 500,
): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new SalesforceDescribeError(`${path}: non-empty string required`);
  }
  return value.trim();
}

function describeApiName(value: unknown, path: string): string {
  const name = describeString(value, path, 255);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
    throw new SalesforceDescribeError(`${path}: Salesforce API name required`);
  }
  return name;
}

function optionalDescribeBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new SalesforceDescribeError(`${path}: boolean required`);
  return value;
}

function optionalDescribeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SalesforceDescribeError(`${path}: non-negative integer required`);
  }
  return Number(value);
}

/** Sanitize the small, durable subset of Salesforce describe metadata we use. */
export function parseSalesforceObjectDescribe(
  value: unknown,
): SalesforceObjectDescribe {
  const raw = describeRecord(value, "describe");
  if (!Array.isArray(raw.fields) || raw.fields.length === 0 || raw.fields.length > 5_000) {
    throw new SalesforceDescribeError("describe.fields: 1 to 5000 fields required");
  }
  const fields = raw.fields.map((candidate, index): SalesforceFieldDescribe => {
    const path = `describe.fields[${index}]`;
    const field = describeRecord(candidate, path);
    const referenceTo = field.referenceTo;
    if (
      referenceTo !== undefined &&
      (!Array.isArray(referenceTo) ||
        referenceTo.length > 100 ||
        !referenceTo.every((entry) => typeof entry === "string"))
    ) {
      throw new SalesforceDescribeError(`${path}.referenceTo: API-name array required`);
    }
    const picklistValues = field.picklistValues;
    if (
      picklistValues !== undefined &&
      (!Array.isArray(picklistValues) || picklistValues.length > 5_000)
    ) {
      throw new SalesforceDescribeError(`${path}.picklistValues: array required`);
    }
    return {
      name: describeApiName(field.name, `${path}.name`),
      label: describeString(field.label ?? field.name, `${path}.label`, 500),
      type: describeString(field.type, `${path}.type`, 100),
      length: optionalDescribeInteger(field.length, `${path}.length`),
      precision: optionalDescribeInteger(field.precision, `${path}.precision`),
      scale: optionalDescribeInteger(field.scale, `${path}.scale`),
      nillable: optionalDescribeBoolean(field.nillable, `${path}.nillable`),
      createable: optionalDescribeBoolean(field.createable, `${path}.createable`),
      updateable: optionalDescribeBoolean(field.updateable, `${path}.updateable`),
      calculated: optionalDescribeBoolean(field.calculated, `${path}.calculated`),
      defaultedOnCreate: optionalDescribeBoolean(
        field.defaultedOnCreate,
        `${path}.defaultedOnCreate`,
      ),
      nameField: optionalDescribeBoolean(field.nameField, `${path}.nameField`),
      compoundFieldName:
        field.compoundFieldName === undefined || field.compoundFieldName === null
          ? field.compoundFieldName === null
            ? null
            : undefined
          : describeApiName(field.compoundFieldName, `${path}.compoundFieldName`),
      referenceTo: Array.isArray(referenceTo)
        ? referenceTo.map((entry, targetIndex) =>
            describeApiName(entry, `${path}.referenceTo[${targetIndex}]`),
          )
        : undefined,
      picklistValues: Array.isArray(picklistValues)
        ? picklistValues.map((entry, valueIndex) => {
            const item = describeRecord(entry, `${path}.picklistValues[${valueIndex}]`);
            return {
              value: describeString(
                item.value,
                `${path}.picklistValues[${valueIndex}].value`,
                2_000,
              ),
              active: optionalDescribeBoolean(
                item.active,
                `${path}.picklistValues[${valueIndex}].active`,
              ),
            };
          })
        : undefined,
    };
  });
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    throw new SalesforceDescribeError("describe.fields: duplicate API names");
  }
  return {
    name: describeApiName(raw.name, "describe.name"),
    label: describeString(raw.label ?? raw.name, "describe.label", 500),
    labelPlural: describeString(
      raw.labelPlural ?? `${String(raw.label ?? raw.name)}s`,
      "describe.labelPlural",
      500,
    ),
    custom: optionalDescribeBoolean(raw.custom, "describe.custom"),
    queryable: optionalDescribeBoolean(raw.queryable, "describe.queryable"),
    replicateable: optionalDescribeBoolean(raw.replicateable, "describe.replicateable"),
    fields,
  };
}

function activePicklistValues(field: SalesforceFieldDescribe): string[] {
  return (field.picklistValues ?? [])
    .filter((value) => value.active !== false && value.value.trim())
    .map((value) => value.value.trim());
}

function mappedKind(field: SalesforceFieldDescribe): RecordFieldKind | null {
  if (field.calculated) return "readonly_formula";
  switch (field.type.toLowerCase()) {
    case "string":
    case "combobox":
    case "encryptedstring":
    case "anytype":
    case "time":
      return "text";
    case "textarea":
      return "textarea";
    case "email":
      return "email";
    case "phone":
      return "phone";
    case "url":
      return "url";
    case "picklist":
      return "picklist";
    case "multipicklist":
      return "multipicklist";
    case "boolean":
      return "boolean";
    case "int":
      return "integer";
    case "double":
      return "decimal";
    case "currency":
      return "currency";
    case "percent":
      return "percent";
    case "date":
      return "date";
    case "datetime":
      return "datetime";
    case "reference":
      return "reference";
    case "id":
      return "text";
    case "address":
    case "location":
    case "base64":
      return null;
    default:
      return "text";
  }
}

function fieldPayload(input: {
  field: SalesforceFieldDescribe;
  objectNames: Map<string, RecordIdentifier>;
  warnings: string[];
}): { payload: Record<string, unknown> | null; mapping: SalesforceFieldMapping } {
  const { field } = input;
  if (field.name === "Id") {
    return {
      payload: null,
      mapping: { sourceField: field.name, targetField: "id", skippedReason: null },
    };
  }
  const kind = mappedKind(field);
  if (kind === null) {
    const reason =
      field.type.toLowerCase() === "base64"
        ? "binary fields are excluded from v1 imports"
        : "compound fields use their flattened component columns";
    input.warnings.push(`${field.name}: ${reason}`);
    return {
      payload: null,
      mapping: { sourceField: field.name, targetField: null, skippedReason: reason },
    };
  }
  const apiName = recordIdentifier(field.name);
  let finalKind = kind;
  let referenceTargets: RecordIdentifier[] | null = null;
  if (kind === "reference") {
    referenceTargets = (field.referenceTo ?? []).flatMap((target) => {
      const resolved = input.objectNames.get(target);
      return resolved ? [resolved] : [];
    });
    if (referenceTargets.length === 0) {
      finalKind = "text";
      referenceTargets = null;
      input.warnings.push(
        `${field.name}: reference targets are outside this export; imported as text`,
      );
    }
  }
  const picklistValues =
    finalKind === "picklist" || finalKind === "multipicklist"
      ? activePicklistValues(field)
      : null;
  if (
    (finalKind === "picklist" || finalKind === "multipicklist") &&
    picklistValues?.length === 0
  ) {
    input.warnings.push(`${field.name}: no active picklist values; imported as text`);
    finalKind = "text";
  }
  const readOnly = Boolean(field.calculated || (!field.createable && !field.updateable));
  return {
    payload: {
      api_name: apiName,
      source_api_name: field.name,
      label: field.label || field.name,
      kind: finalKind,
      required: Boolean(
        !readOnly && field.nillable === false && field.defaultedOnCreate !== true,
      ),
      read_only: readOnly,
      ...(finalKind === "picklist" || finalKind === "multipicklist"
        ? { picklist_values: picklistValues }
        : {}),
      ...(finalKind === "reference"
        ? { reference_targets: referenceTargets }
        : {}),
      ...(field.length && field.length > 0 ? { length: field.length } : {}),
      ...((finalKind === "decimal" ||
        finalKind === "currency" ||
        finalKind === "percent") &&
      field.scale !== undefined
        ? { scale: Math.max(0, field.scale) }
        : {}),
    },
    mapping: { sourceField: field.name, targetField: apiName, skippedReason: null },
  };
}

/** Translate Salesforce describes into the same approval-ready app model as chat. */
export function buildSalesforceAppSchema(input: {
  app: string;
  label: string;
  purpose?: string | null;
  mode: RecordConnectorMode;
  describes: SalesforceObjectDescribe[];
}): SalesforceSchemaPlan {
  if (input.describes.length === 0) {
    throw new Error("Salesforce schema requires at least one object describe");
  }
  const warnings: string[] = [];
  const objectNames = new Map(
    input.describes.map((describe) => [describe.name, recordIdentifier(describe.name)]),
  );
  if (new Set(objectNames.values()).size !== objectNames.size) {
    throw new Error("Salesforce object names collide after records normalization");
  }
  const mappings: SalesforceObjectMapping[] = [];
  const objects = input.describes.map((describe) => {
    const targetObject = objectNames.get(describe.name)!;
    const mapped = describe.fields.map((field) =>
      fieldPayload({ field, objectNames, warnings }),
    );
    const fields = mapped.flatMap((field) => (field.payload ? [field.payload] : []));
    if (fields.length === 0) {
      throw new Error(`${describe.name}: no importable Salesforce fields`);
    }
    mappings.push({
      sourceObject: describe.name,
      targetObject,
      fields: mapped.map((field) => field.mapping),
    });
    const nameSource =
      describe.fields.find((field) => field.nameField && field.name !== "Id")?.name ??
      describe.fields.find((field) => field.name === "Name")?.name;
    const nameField =
      mapped.find(
        (field) =>
          field.mapping.sourceField === nameSource && field.mapping.targetField !== null,
      )?.mapping.targetField ?? mapped.find((field) => field.payload)?.mapping.targetField;
    if (!nameField || nameField === "id") {
      throw new Error(`${describe.name}: no usable name field`);
    }
    const fieldNames = fields.map((field) => String(field.api_name));
    const listColumns = [String(nameField), ...fieldNames.filter((name) => name !== nameField)].slice(
      0,
      6,
    );
    return {
      api_name: targetObject,
      source_api_name: describe.name,
      label: describe.label || describe.name,
      plural_label: describe.labelPlural || `${describe.label || describe.name}s`,
      name_field: nameField,
      visibility: describe.fields.some((field) => field.name === "OwnerId")
        ? "owner"
        : "org",
      custom: Boolean(describe.custom),
      fields,
      layouts: [
        { kind: "list", definition: { columns: listColumns } },
        { kind: "detail", definition: { fields: fieldNames } },
      ],
    };
  });
  const writable = input.mode === "primary";
  const permissions = objects.flatMap((object) => [
    {
      role: "admin",
      object: object.api_name,
      read: true,
      create: writable,
      update: writable,
      delete: writable,
    },
    {
      role: "member",
      object: object.api_name,
      read: true,
      create: false,
      update: false,
      delete: false,
    },
  ]);
  return {
    definition: parseRecordAppDefinition({
      app: input.app,
      label: input.label,
      purpose: input.purpose ?? "Mirror imported from Salesforce",
      objects,
      permissions,
    }),
    mappings,
    warnings,
  };
}
