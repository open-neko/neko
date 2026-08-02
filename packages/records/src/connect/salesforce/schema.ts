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
