import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRecordIdentifier } from "./naming";
import {
  parseRecordAppDefinition,
  type RecordAppDefinition,
} from "./schema/definition";
import type { JsonObject, RecordIdentifier } from "./types";

const BLUEPRINT_SCHEMA_VERSION = 1;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+$/;
const BLUEPRINTS_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "blueprints",
);

export type RecordAppBlueprint = {
  schemaVersion: typeof BLUEPRINT_SCHEMA_VERSION;
  id: RecordIdentifier;
  version: string;
  description: string;
  /** Approval-ready app_create payload, preserved in its authored JSON shape. */
  payload: JsonObject;
  /** Parsed form used by the registry planner and validation tooling. */
  definition: RecordAppDefinition;
};

export class RecordAppBlueprintError extends Error {
  readonly code = "records_app_blueprint_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordAppBlueprintError";
  }
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordAppBlueprintError(`${path}: object required`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RecordAppBlueprintError(`${path}: non-empty string required`);
  }
  return value.trim();
}

function blueprintId(value: string): RecordIdentifier {
  try {
    return validateRecordIdentifier(value);
  } catch {
    throw new RecordAppBlueprintError(
      "blueprint id must be a canonical records identifier",
    );
  }
}

function parseBlueprint(
  requestedId: RecordIdentifier,
  source: string,
): RecordAppBlueprint {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new RecordAppBlueprintError(`${requestedId}: invalid JSON`);
  }
  const raw = objectValue(value, requestedId);
  if (raw.schema_version !== BLUEPRINT_SCHEMA_VERSION) {
    throw new RecordAppBlueprintError(
      `${requestedId}.schema_version: expected ${BLUEPRINT_SCHEMA_VERSION}`,
    );
  }
  const declaredId = blueprintId(nonEmptyString(raw.id, `${requestedId}.id`));
  if (declaredId !== requestedId) {
    throw new RecordAppBlueprintError(
      `${requestedId}.id: must match blueprint filename`,
    );
  }
  const version = nonEmptyString(raw.version, `${requestedId}.version`);
  if (!SEMANTIC_VERSION.test(version)) {
    throw new RecordAppBlueprintError(
      `${requestedId}.version: semantic version required`,
    );
  }
  const description = nonEmptyString(
    raw.description,
    `${requestedId}.description`,
  );
  const payload = {
    ...objectValue(raw.definition, `${requestedId}.definition`),
  };
  const definition = parseRecordAppDefinition(payload);
  if (definition.appId !== requestedId) {
    throw new RecordAppBlueprintError(
      `${requestedId}.definition.app: must normalize to ${requestedId}`,
    );
  }
  return {
    schemaVersion: BLUEPRINT_SCHEMA_VERSION,
    id: declaredId,
    version,
    description,
    payload,
    definition,
  };
}

/** Load and validate one shipped blueprint without permitting path traversal. */
export async function loadRecordAppBlueprint(
  id: string,
): Promise<RecordAppBlueprint> {
  const safeId = blueprintId(id);
  let source: string;
  try {
    source = await readFile(join(BLUEPRINTS_ROOT, `${safeId}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new RecordAppBlueprintError(`unknown records blueprint: ${safeId}`);
    }
    throw error;
  }
  return parseBlueprint(safeId, source);
}

/** Enumerate every shipped blueprint in stable identifier order. */
export async function listRecordAppBlueprints(): Promise<RecordAppBlueprint[]> {
  const entries = await readdir(BLUEPRINTS_ROOT, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort();
  return Promise.all(ids.map(loadRecordAppBlueprint));
}
