import { createHash } from "node:crypto";
import { posix } from "node:path";
import { validateRecordIdentifier } from "../naming";
import type { JsonObject } from "../types";
import {
  RECORDS_ARTIFACT_FORMAT,
  type RecordArtifactObject,
  type RecordConnectorMode,
  type RecordsArtifactManifest,
} from "./types";

export class RecordsArtifactManifestError extends Error {
  readonly code = "records_artifact_manifest_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordsArtifactManifestError";
  }
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordsArtifactManifestError(`${path}: object required`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RecordsArtifactManifestError(`${path}: non-empty string required`);
  }
  const result = value.trim();
  if (result.length > max) {
    throw new RecordsArtifactManifestError(`${path}: exceeds ${max} characters`);
  }
  return result;
}

function integerValue(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RecordsArtifactManifestError(`${path}: non-negative integer required`);
  }
  return Number(value);
}

function jsonObjectValue(value: unknown, path: string): JsonObject | null {
  if (value === undefined || value === null) return null;
  return { ...objectValue(value, path) };
}

function artifactPath(value: unknown, path: string, root: "data" | "describe"): string {
  const source = stringValue(value, path, 1_000).replaceAll("\\", "/");
  if (source.startsWith("/") || /^[A-Za-z]:\//.test(source)) {
    throw new RecordsArtifactManifestError(`${path}: relative path required`);
  }
  const normalized = posix.normalize(source);
  const extension = root === "data" ? ".csv" : ".json";
  if (
    normalized !== source ||
    normalized.startsWith("../") ||
    !normalized.startsWith(`${root}/`) ||
    !normalized.endsWith(extension)
  ) {
    throw new RecordsArtifactManifestError(
      `${path}: must be a normalized ${root}/${extension === ".csv" ? "*.csv" : "*.json"} path`,
    );
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function manifestHash(value: Omit<RecordsArtifactManifest, "manifestHash">): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function connectorMode(value: unknown): RecordConnectorMode {
  if (value !== "mirror" && value !== "primary") {
    throw new RecordsArtifactManifestError("manifest.source.mode: mirror or primary required");
  }
  return value;
}

function parseObject(value: unknown, index: number): RecordArtifactObject {
  const path = `manifest.objects[${index}]`;
  const raw = objectValue(value, path);
  const describePath =
    raw.describe_path === undefined || raw.describe_path === null
      ? null
      : artifactPath(raw.describe_path, `${path}.describe_path`, "describe");
  const sha256 = stringValue(raw.sha256, `${path}.sha256`, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new RecordsArtifactManifestError(`${path}.sha256: lowercase SHA-256 required`);
  }
  let objectApiName;
  try {
    objectApiName = validateRecordIdentifier(
      stringValue(raw.object_api_name, `${path}.object_api_name`, 63),
    );
  } catch {
    throw new RecordsArtifactManifestError(
      `${path}.object_api_name: canonical records identifier required`,
    );
  }
  return {
    sourceApiName: stringValue(raw.source_api_name, `${path}.source_api_name`),
    objectApiName,
    dataPath: artifactPath(raw.data_path, `${path}.data_path`, "data"),
    describePath,
    expectedRows: integerValue(raw.expected_rows, `${path}.expected_rows`),
    sha256,
    watermark: jsonObjectValue(raw.watermark, `${path}.watermark`),
  };
}

/** Parse and hash an export manifest before any file is trusted or opened. */
export function parseRecordsArtifactManifest(value: unknown): RecordsArtifactManifest {
  const raw = objectValue(value, "manifest");
  if (raw.format !== RECORDS_ARTIFACT_FORMAT) {
    throw new RecordsArtifactManifestError(
      `manifest.format: expected ${RECORDS_ARTIFACT_FORMAT}`,
    );
  }
  const source = objectValue(raw.source, "manifest.source");
  const generatedAt = stringValue(raw.generated_at, "manifest.generated_at", 100);
  if (Number.isNaN(Date.parse(generatedAt))) {
    throw new RecordsArtifactManifestError("manifest.generated_at: ISO timestamp required");
  }
  if (!Array.isArray(raw.objects) || raw.objects.length === 0) {
    throw new RecordsArtifactManifestError("manifest.objects: non-empty array required");
  }
  const objects = raw.objects.map(parseObject).sort((left, right) =>
    left.objectApiName.localeCompare(right.objectApiName),
  );
  for (const [label, values] of [
    ["source API names", objects.map((object) => object.sourceApiName)],
    ["object API names", objects.map((object) => object.objectApiName)],
    ["data paths", objects.map((object) => object.dataPath)],
  ] as const) {
    if (new Set(values).size !== values.length) {
      throw new RecordsArtifactManifestError(`manifest.objects: duplicate ${label}`);
    }
  }
  const unsigned: Omit<RecordsArtifactManifest, "manifestHash"> = {
    format: RECORDS_ARTIFACT_FORMAT,
    source: {
      kind: stringValue(source.kind, "manifest.source.kind", 100),
      instanceId: stringValue(source.instance_id, "manifest.source.instance_id", 500),
      mode: connectorMode(source.mode),
    },
    generatedAt: new Date(generatedAt).toISOString(),
    watermark: jsonObjectValue(raw.watermark, "manifest.watermark"),
    objects,
  };
  return { ...unsigned, manifestHash: manifestHash(unsigned) };
}

/** Stable JSON shape written by connectors and accepted from client-supplied dumps. */
export function serializeRecordsArtifactManifest(
  manifest: RecordsArtifactManifest,
): string {
  const value = {
    format: manifest.format,
    source: {
      kind: manifest.source.kind,
      instance_id: manifest.source.instanceId,
      mode: manifest.source.mode,
    },
    generated_at: manifest.generatedAt,
    watermark: manifest.watermark,
    objects: manifest.objects.map((object) => ({
      source_api_name: object.sourceApiName,
      object_api_name: object.objectApiName,
      data_path: object.dataPath,
      describe_path: object.describePath,
      expected_rows: object.expectedRows,
      sha256: object.sha256,
      watermark: object.watermark,
    })),
  };
  const reparsed = parseRecordsArtifactManifest(value);
  if (reparsed.manifestHash !== manifest.manifestHash) {
    throw new RecordsArtifactManifestError("manifest changed after it was approved");
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}
