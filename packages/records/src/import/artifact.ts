import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  parseRecordsArtifactManifest,
  serializeRecordsArtifactManifest,
} from "../connect/artifacts";
import {
  buildSalesforceAppSchema,
  parseSalesforceObjectDescribe,
  salesforceSchemaPlanHash,
  type SalesforceObjectDescribe,
} from "../connect/salesforce/schema";
import type { RecordsArtifactManifest } from "../connect/types";
import { recordIdentifier } from "../naming";
import type { RecordAppDefinition } from "../schema/definition";
import type { AppRegistrySnapshot } from "../types";
import { parseRecordsCsv } from "./csv";
import {
  buildRecordImportPlan,
  normalizeRecordImportSourcePath,
  verifyRecordImportPlanHash,
  type RecordImportPlan,
} from "./plan";

const ARTIFACT_IMPORT_FORMAT = "openneko.records.artifact-import.v1" as const;

export type RecordArtifactImportPlan = {
  format: typeof ARTIFACT_IMPORT_FORMAT;
  directory: string;
  manifest: RecordsArtifactManifest;
  definition: RecordAppDefinition;
  sourceSchemaHash: string;
  imports: RecordImportPlan[];
  warnings: string[];
  planHash: string;
};

export class RecordArtifactImportPlanError extends Error {
  readonly code = "records_artifact_import_plan_invalid";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RecordArtifactImportPlanError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new RecordArtifactImportPlanError(`${label}: valid UTF-8 required`, {
      cause: error,
    });
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes, label)) as unknown;
  } catch (error) {
    if (error instanceof RecordArtifactImportPlanError) throw error;
    throw new RecordArtifactImportPlanError(`${label}: valid JSON required`, {
      cause: error,
    });
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

function hashPlan(plan: Omit<RecordArtifactImportPlan, "planHash">): string {
  return sha256(canonicalJson(plan));
}

function normalizedDirectory(value: string): string {
  let normalized: string;
  try {
    normalized = normalizeRecordImportSourcePath(value);
  } catch (error) {
    throw new RecordArtifactImportPlanError(
      "artifact directory must be staged below imports/",
      { cause: error },
    );
  }
  if (!normalized.startsWith("imports/") || normalized.endsWith(".csv")) {
    throw new RecordArtifactImportPlanError(
      "artifact directory must be staged below imports/",
    );
  }
  return normalized.replace(/\/$/, "");
}

function artifactPath(directory: string, relativePath: string): string {
  return normalizeRecordImportSourcePath(posix.join(directory, relativePath));
}

function snapshotFromDefinition(definition: RecordAppDefinition): AppRegistrySnapshot {
  const objects = definition.objects.map((object, index) => ({
    id: `artifact-object-${index}`,
    orgId: "artifact-plan",
    appId: definition.appId,
    apiName: object.apiName,
    sourceApiName: object.sourceApiName,
    label: object.label,
    pluralLabel: object.pluralLabel,
    tableSchema: recordIdentifier("public"),
    tableName: object.tableName,
    nameField: object.nameField,
    visibility: object.visibility,
    custom: object.custom,
    archivedAt: object.archived ? new Date(0) : null,
    recordCount: null,
  }));
  return {
    revision: "0",
    app: {
      orgId: "artifact-plan",
      appId: definition.appId,
      label: definition.label,
      purpose: definition.purpose,
      status: "active",
      navOrder: definition.navOrder,
      registryRevision: "0",
    },
    objects,
    fields: definition.objects.flatMap((object, objectIndex) =>
      object.fields.map((field, fieldIndex) => ({
        id: `artifact-field-${objectIndex}-${fieldIndex}`,
        orgId: "artifact-plan",
        objectId: objects[objectIndex]!.id,
        apiName: field.apiName,
        sourceApiName: field.sourceApiName,
        label: field.label,
        kind: field.kind,
        columnName: field.columnName,
        required: field.required,
        readOnly: field.readOnly,
        archivedAt: field.archived ? new Date(0) : null,
        picklistValues: field.picklistValues,
        referenceTargets: field.referenceTargets,
        length: field.length,
        scale: field.scale,
      })),
    ),
    layouts: definition.objects.flatMap((object, objectIndex) =>
      object.layouts.map((layout) => ({
        objectId: objects[objectIndex]!.id,
        kind: layout.kind,
        definition: layout.definition,
      })),
    ),
    pages: definition.pages.map((page, index) => ({
      id: `artifact-page-${index}`,
      apiName: page.apiName,
      label: page.label,
      definition: page.definition,
      navOrder: page.navOrder,
    })),
    permissions: definition.permissions.map((permission) => ({
      appId: definition.appId,
      role: permission.role,
      objectApiName: permission.objectApiName,
      canRead: permission.canRead,
      canCreate: permission.canCreate,
      canUpdate: permission.canUpdate,
      canDelete: permission.canDelete,
    })),
  };
}

function verifyManifest(manifest: RecordsArtifactManifest): void {
  const reparsed = parseRecordsArtifactManifest(
    JSON.parse(serializeRecordsArtifactManifest(manifest)),
  );
  if (reparsed.manifestHash !== manifest.manifestHash) {
    throw new RecordArtifactImportPlanError("artifact manifest changed after planning");
  }
}

/** Verify an immutable artifact plan before schema or row mutations begin. */
export function verifyRecordArtifactImportPlan(plan: RecordArtifactImportPlan): void {
  if (plan.format !== ARTIFACT_IMPORT_FORMAT) {
    throw new RecordArtifactImportPlanError("artifact import format is invalid");
  }
  verifyManifest(plan.manifest);
  if (!/^[0-9a-f]{64}$/.test(plan.sourceSchemaHash)) {
    throw new RecordArtifactImportPlanError(
      "artifact import source schema hash is invalid",
    );
  }
  if (plan.definition.appId === "" || plan.imports.length !== plan.manifest.objects.length) {
    throw new RecordArtifactImportPlanError("artifact import object set is incomplete");
  }
  const expectedObjects = plan.manifest.objects.map((object) => object.objectApiName).sort();
  const plannedObjects = plan.imports.map((item) => item.objectApiName).sort();
  if (expectedObjects.some((object, index) => object !== plannedObjects[index])) {
    throw new RecordArtifactImportPlanError("artifact import object set changed after planning");
  }
  for (const item of plan.imports) {
    verifyRecordImportPlanHash(item);
    if (item.appId !== plan.definition.appId) {
      throw new RecordArtifactImportPlanError("artifact import app identity is inconsistent");
    }
  }
  const { planHash: expected, ...unsigned } = plan;
  if (hashPlan(unsigned) !== expected) {
    throw new RecordArtifactImportPlanError("artifact import plan changed after approval");
  }
}

/**
 * Read and reconcile a Salesforce artifact directory into one schema proposal
 * plus immutable per-object CSV plans. No target schema or rows are changed.
 */
export async function buildRecordArtifactImportPlan(input: {
  directory: string;
  app: string;
  label: string;
  purpose?: string | null;
  batchSize?: number;
  ownerUserId?: string | null;
  readFile: (relativePath: string) => Promise<Uint8Array>;
}): Promise<RecordArtifactImportPlan> {
  const directory = normalizedDirectory(input.directory);
  const manifestBytes = await input.readFile(
    artifactPath(directory, "export-manifest.json"),
  );
  if (manifestBytes.byteLength > 16 * 1024 * 1024) {
    throw new RecordArtifactImportPlanError("artifact manifest exceeds 16 MiB");
  }
  let manifest: RecordsArtifactManifest;
  try {
    manifest = parseRecordsArtifactManifest(
      parseJson(manifestBytes, "export-manifest.json"),
    );
  } catch (error) {
    if (error instanceof RecordArtifactImportPlanError) throw error;
    throw new RecordArtifactImportPlanError("artifact manifest is invalid", {
      cause: error,
    });
  }
  if (manifest.source.kind !== "salesforce") {
    throw new RecordArtifactImportPlanError(
      `artifact connector ${manifest.source.kind} is not supported yet`,
    );
  }

  const describes: SalesforceObjectDescribe[] = [];
  for (const object of manifest.objects) {
    if (!object.describePath) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: Salesforce describe metadata is required`,
      );
    }
    const bytes = await input.readFile(artifactPath(directory, object.describePath));
    if (bytes.byteLength > 16 * 1024 * 1024) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: describe metadata exceeds 16 MiB`,
      );
    }
    const describe = parseSalesforceObjectDescribe(
      parseJson(bytes, object.describePath),
    );
    if (describe.name !== object.sourceApiName) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: describe metadata belongs to ${describe.name}`,
      );
    }
    describes.push(describe);
  }

  const schema = buildSalesforceAppSchema({
    app: input.app,
    label: input.label,
    purpose: input.purpose,
    mode: manifest.source.mode,
    describes,
  });
  const snapshot = snapshotFromDefinition(schema.definition);
  const imports: RecordImportPlan[] = [];
  for (const object of manifest.objects) {
    const mapping = schema.mappings.find(
      (candidate) => candidate.sourceObject === object.sourceApiName,
    );
    const describe = describes.find(
      (candidate) => candidate.name === object.sourceApiName,
    );
    if (!mapping || !describe || mapping.targetObject !== object.objectApiName) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: manifest and schema mapping disagree`,
      );
    }
    const sourcePath = artifactPath(directory, object.dataPath);
    const bytes = await input.readFile(sourcePath);
    if (sha256(bytes) !== object.sha256) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: CSV checksum does not match the manifest`,
      );
    }
    const parsed = parseRecordsCsv(decodeUtf8(bytes, object.dataPath));
    if (parsed.rows.length !== object.expectedRows) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: expected ${object.expectedRows} rows, found ${parsed.rows.length}`,
      );
    }
    const targets = new Map(
      mapping.fields.map((field) => [field.sourceField, field.targetField]),
    );
    const expectedHeaders = mapping.fields
      .filter((field) => field.targetField !== null)
      .map((field) => field.sourceField);
    if (
      parsed.headers.length !== expectedHeaders.length ||
      parsed.headers.some((header, index) => header !== expectedHeaders[index])
    ) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: CSV headers do not match approved describe metadata`,
      );
    }
    const fieldTypes = new Map(describe.fields.map((field) => [field.name, field.type]));
    const plan = buildRecordImportPlan({
      snapshot,
      objectApiName: object.objectApiName,
      sourcePath,
      sourceName: posix.basename(object.dataPath),
      bytes,
      mapping: Object.fromEntries(
        parsed.headers.map((header) => [header, targets.get(header) ?? null]),
      ),
      batchSize: input.batchSize,
      ownerUserId: input.ownerUserId,
      allowReadOnly: true,
      normalizeIdColumns: parsed.headers.filter((header) =>
        ["id", "reference"].includes(fieldTypes.get(header)?.toLowerCase() ?? ""),
      ),
    });
    if (plan.rowCount !== object.expectedRows || plan.source.sha256 !== object.sha256) {
      throw new RecordArtifactImportPlanError(
        `${object.sourceApiName}: CSV plan does not reconcile to the manifest`,
      );
    }
    imports.push(plan);
  }

  const unsigned: Omit<RecordArtifactImportPlan, "planHash"> = {
    format: ARTIFACT_IMPORT_FORMAT,
    directory,
    manifest,
    definition: schema.definition,
    sourceSchemaHash: salesforceSchemaPlanHash({
      sourceInstanceId: manifest.source.instanceId,
      mode: manifest.source.mode,
      plan: schema,
    }),
    imports,
    warnings: schema.warnings,
  };
  const plan = { ...unsigned, planHash: hashPlan(unsigned) };
  verifyRecordArtifactImportPlan(plan);
  return plan;
}
