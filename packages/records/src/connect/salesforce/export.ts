import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseRecordsArtifactManifest, serializeRecordsArtifactManifest } from "../artifacts";
import type {
  RecordConnectorDelta,
  RecordConnectorExportResult,
  RecordConnectorInventory,
  RecordConnectorMode,
  RecordsConnector,
} from "../types";
import {
  SalesforceApiClient,
  type SalesforceApiBudgetSnapshot,
} from "./client";
import { normalizeSalesforceId } from "./id";
import {
  buildSalesforceAppSchema,
  createSalesforceSchemaReview,
  parseSalesforceObjectDescribe,
  type SalesforceObjectDescribe,
  type SalesforceSchemaReview,
  type SalesforceSchemaPlan,
} from "./schema";

const CHECKPOINT_FORMAT = "openneko.records.salesforce-export.v1";
const SALESFORCE_API_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

type ExportObjectCheckpoint = {
  sourceApiName: string;
  targetApiName: string;
  jobId: string | null;
  state: "pending" | "querying" | "pages" | "complete";
  nextLocator: string | null;
  pagesComplete: boolean;
  page: number;
  rows: number;
  sha256: string | null;
};

type ExportCheckpoint = {
  format: typeof CHECKPOINT_FORMAT;
  sourceInstanceId: string;
  mode: RecordConnectorMode;
  startedAt: string;
  apiBudget: SalesforceApiBudgetSnapshot | null;
  objects: Record<string, ExportObjectCheckpoint>;
};

type SObjectList = {
  sobjects?: Array<{
    name?: string;
    label?: string;
    labelPlural?: string;
    queryable?: boolean;
    replicateable?: boolean;
    deprecatedAndHidden?: boolean;
    custom?: boolean;
  }>;
};

type BulkJob = {
  id?: string;
  state?: string;
  errorMessage?: string;
};

type QueryResult = {
  totalSize?: number;
  done?: boolean;
  nextRecordsUrl?: string;
  records?: Array<Record<string, unknown>>;
};

export class SalesforceExportError extends Error {
  readonly code = "salesforce_export_failed";

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "SalesforceExportError";
  }
}

function assertApiName(value: string, label: string): string {
  if (!SALESFORCE_API_NAME.test(value) || value.length > 255) {
    throw new SalesforceExportError(`${label}: invalid Salesforce API name`);
  }
  return value;
}

function quotedSoqlIdentifier(value: string): string {
  return assertApiName(value, "SOQL identifier");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWrite(path: string, bytes: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeCheckpointFile(root: string, checkpoint: ExportCheckpoint): Promise<void> {
  await atomicWrite(
    join(root, "export-checkpoint.json"),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
  );
}

function csvWithoutHeader(bytes: Uint8Array): Uint8Array {
  const newline = bytes.indexOf(10);
  return newline === -1 ? new Uint8Array() : bytes.slice(newline + 1);
}

async function mergeCsvParts(input: {
  partsDirectory: string;
  pages: number;
  destination: string;
}): Promise<{ sha256: string }> {
  const temporary = `${input.destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  const hash = createHash("sha256");
  try {
    for (let page = 0; page < input.pages; page += 1) {
      const raw = new Uint8Array(
        await readFile(join(input.partsDirectory, `${page}.csv`)),
      );
      const chunk = page === 0 ? raw : csvWithoutHeader(raw);
      await handle.write(chunk);
      hash.update(chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, input.destination);
  return { sha256: hash.digest("hex") };
}

function sourceFields(plan: SalesforceSchemaPlan, sourceObject: string): string[] {
  const mapping = plan.mappings.find((candidate) => candidate.sourceObject === sourceObject);
  if (!mapping) throw new SalesforceExportError(`${sourceObject}: schema mapping is missing`);
  return mapping.fields
    .filter((field) => field.targetField !== null)
    .map((field) => quotedSoqlIdentifier(field.sourceField));
}

function checkpointObject(
  sourceApiName: string,
  targetApiName: string,
): ExportObjectCheckpoint {
  return {
    sourceApiName,
    targetApiName,
    jobId: null,
    state: "pending",
    nextLocator: null,
    pagesComplete: false,
    page: 0,
    rows: 0,
    sha256: null,
  };
}

function normalizedRecord(
  describe: SalesforceObjectDescribe,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...raw };
  delete result.attributes;
  for (const field of describe.fields) {
    if (field.name !== "Id" && field.type.toLowerCase() !== "reference") continue;
    const value = result[field.name];
    if (typeof value === "string" && value.trim()) {
      result[field.name] = normalizeSalesforceId(value);
    }
  }
  return result;
}

export class SalesforceConnector implements RecordsConnector {
  private readonly describes = new Map<string, SalesforceObjectDescribe>();
  private discovered: SObjectList["sobjects"] | null = null;

  constructor(
    private readonly options: {
      client: SalesforceApiClient;
      sourceInstanceId: string;
      mode: RecordConnectorMode;
      app: string;
      label: string;
      purpose?: string | null;
      objects?: string[];
      maxObjects?: number;
      maxRecordsPerPage?: number;
      pollIntervalMs?: number;
      maxPolls?: number;
      now?: () => Date;
      sleep?: (milliseconds: number) => Promise<void>;
    },
  ) {
    if (!options.sourceInstanceId.trim()) {
      throw new Error("Salesforce source instance id is required");
    }
    for (const object of options.objects ?? []) assertApiName(object, "Salesforce object");
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async sleep(milliseconds: number): Promise<void> {
    await (this.options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
      milliseconds,
    );
  }

  private async sobjects(signal?: AbortSignal): Promise<NonNullable<SObjectList["sobjects"]>> {
    if (!this.discovered) {
      const value = await this.options.client.json<SObjectList>(
        this.options.client.dataPath("/sobjects"),
        { signal },
      );
      this.discovered = value.sobjects ?? [];
    }
    return this.discovered;
  }

  private async selectedObjects(signal?: AbortSignal): Promise<string[]> {
    const inventory = await this.sobjects(signal);
    const available = new Map(
      inventory
        .filter((object) => object.name && object.queryable && !object.deprecatedAndHidden)
        .map((object) => [object.name!, object]),
    );
    const requested = this.options.objects ?? [...available.keys()].sort();
    const missing = requested.filter((name) => !available.has(name));
    if (missing.length > 0) {
      throw new SalesforceExportError(
        `Salesforce objects are missing or not queryable: ${missing.sort().join(", ")}`,
      );
    }
    const max = this.options.maxObjects ?? 500;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error("Salesforce maxObjects must be a positive integer");
    }
    return requested.slice(0, max);
  }

  private async describe(
    sourceApiName: string,
    signal?: AbortSignal,
  ): Promise<SalesforceObjectDescribe> {
    const existing = this.describes.get(sourceApiName);
    if (existing) return existing;
    const raw = await this.options.client.json<unknown>(
      this.options.client.dataPath(
        `/sobjects/${encodeURIComponent(assertApiName(sourceApiName, "Salesforce object"))}/describe`,
      ),
      { signal },
    );
    const value = parseSalesforceObjectDescribe(raw);
    if (value.name !== sourceApiName) {
      throw new SalesforceExportError(`${sourceApiName}: malformed Salesforce describe`);
    }
    this.describes.set(sourceApiName, value);
    return value;
  }

  private async count(sourceApiName: string, signal?: AbortSignal): Promise<number | null> {
    const query = `SELECT count() FROM ${quotedSoqlIdentifier(sourceApiName)}`;
    const result = await this.options.client.json<QueryResult>(
      `${this.options.client.dataPath("/query")}?q=${encodeURIComponent(query)}`,
      { signal },
    );
    return Number.isSafeInteger(result.totalSize) && Number(result.totalSize) >= 0
      ? Number(result.totalSize)
      : null;
  }

  async discover(signal?: AbortSignal): Promise<RecordConnectorInventory> {
    const all = await this.sobjects(signal);
    const selected = await this.selectedObjects(signal);
    const byName = new Map(all.filter((item) => item.name).map((item) => [item.name!, item]));
    const objects = [];
    for (const name of selected) {
      const [describe, estimatedRows] = await Promise.all([
        this.describe(name, signal),
        this.count(name, signal),
      ]);
      const summary = byName.get(name);
      objects.push({
        sourceApiName: name,
        label: describe.label || summary?.label || name,
        pluralLabel: describe.labelPlural || summary?.labelPlural || `${name}s`,
        queryable: summary?.queryable === true,
        replicateable: summary?.replicateable === true,
        estimatedRows,
        fields: describe.fields.length,
      });
    }
    const queryableCount = all.filter(
      (object) => object.name && object.queryable && !object.deprecatedAndHidden,
    ).length;
    return {
      connector: "salesforce",
      sourceInstanceId: this.options.sourceInstanceId,
      mode: this.options.mode,
      objects,
      warnings:
        selected.length < queryableCount
          ? [`Discovery limited to ${selected.length} of ${queryableCount} queryable objects`]
          : [],
    };
  }

  /** Resolve the exact credential-free schema plan that export will consume. */
  async schemaPlan(signal?: AbortSignal): Promise<SalesforceSchemaPlan> {
    const selected = await this.selectedObjects(signal);
    const describes: SalesforceObjectDescribe[] = [];
    for (const name of selected) describes.push(await this.describe(name, signal));
    return buildSalesforceAppSchema({
      app: this.options.app,
      label: this.options.label,
      purpose: this.options.purpose,
      mode: this.options.mode,
      describes,
    });
  }

  /** Package the exact migration plan for an approval card. */
  async schemaReview(signal?: AbortSignal): Promise<SalesforceSchemaReview> {
    return createSalesforceSchemaReview({
      sourceInstanceId: this.options.sourceInstanceId,
      mode: this.options.mode,
      plan: await this.schemaPlan(signal),
    });
  }

  private async loadCheckpoint(root: string, resume: boolean): Promise<ExportCheckpoint> {
    const path = join(root, "export-checkpoint.json");
    const existing = await readJson<ExportCheckpoint>(path);
    if (existing) {
      if (!resume) {
        throw new SalesforceExportError(
          "Salesforce export checkpoint already exists; explicitly resume or choose a new directory",
        );
      }
      if (
        existing.format !== CHECKPOINT_FORMAT ||
        existing.sourceInstanceId !== this.options.sourceInstanceId ||
        existing.mode !== this.options.mode
      ) {
        throw new SalesforceExportError("Salesforce export checkpoint belongs to another source");
      }
      this.options.client.restoreBudget(existing.apiBudget ?? null);
      return existing;
    }
    return {
      format: CHECKPOINT_FORMAT,
      sourceInstanceId: this.options.sourceInstanceId,
      mode: this.options.mode,
      startedAt: this.now().toISOString(),
      apiBudget: this.options.client.budgetSnapshot(),
      objects: {},
    };
  }

  private async writeCheckpoint(
    root: string,
    checkpoint: ExportCheckpoint,
  ): Promise<void> {
    checkpoint.apiBudget = this.options.client.budgetSnapshot();
    await writeCheckpointFile(root, checkpoint);
  }

  private async createBulkJob(
    sourceApiName: string,
    fields: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const query = `SELECT ${fields.join(", ")} FROM ${quotedSoqlIdentifier(sourceApiName)}`;
    const job = await this.options.client.json<BulkJob>(
      this.options.client.dataPath("/jobs/query"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "queryAll",
          query,
          contentType: "CSV",
          columnDelimiter: "COMMA",
          lineEnding: "LF",
        }),
        signal,
      },
    );
    if (typeof job.id !== "string" || !job.id) {
      throw new SalesforceExportError(`${sourceApiName}: Bulk API did not return a job id`);
    }
    return job.id;
  }

  private async waitForBulkJob(jobId: string, signal?: AbortSignal): Promise<void> {
    const maximum = this.options.maxPolls ?? 720;
    for (let poll = 0; poll < maximum; poll += 1) {
      const job = await this.options.client.json<BulkJob>(
        this.options.client.dataPath(`/jobs/query/${encodeURIComponent(jobId)}`),
        { signal },
      );
      if (job.state === "JobComplete") return;
      if (job.state === "Failed" || job.state === "Aborted") {
        throw new SalesforceExportError(
          `Salesforce Bulk job ${jobId} ${job.state.toLowerCase()}: ${job.errorMessage ?? "unknown error"}`,
        );
      }
      await this.sleep(this.options.pollIntervalMs ?? 2_000);
    }
    throw new SalesforceExportError(`Salesforce Bulk job ${jobId} exceeded its poll budget`);
  }

  private async exportObject(input: {
    root: string;
    checkpoint: ExportCheckpoint;
    sourceApiName: string;
    targetApiName: string;
    fields: string[];
    signal?: AbortSignal;
  }): Promise<ExportObjectCheckpoint> {
    const current =
      input.checkpoint.objects[input.sourceApiName] ??
      checkpointObject(input.sourceApiName, input.targetApiName);
    if (current.targetApiName !== input.targetApiName) {
      throw new SalesforceExportError(`${input.sourceApiName}: target changed after export began`);
    }
    input.checkpoint.objects[input.sourceApiName] = current;
    const dataPath = join(input.root, "data", `${input.targetApiName}.csv`);
    const parts = join(input.root, ".pages", input.targetApiName);
    await mkdir(parts, { recursive: true, mode: 0o700 });

    if (current.state === "complete") {
      try {
        const bytes = new Uint8Array(await readFile(dataPath));
        if (current.sha256 === sha256(bytes)) return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      current.state = "pages";
    }
    if (!current.jobId) {
      current.jobId = await this.createBulkJob(
        input.sourceApiName,
        input.fields,
        input.signal,
      );
      current.state = "querying";
      await this.writeCheckpoint(input.root, input.checkpoint);
    }
    if (current.state === "querying" || current.state === "pending") {
      await this.waitForBulkJob(current.jobId, input.signal);
      current.state = "pages";
      await this.writeCheckpoint(input.root, input.checkpoint);
    }
    while (!current.pagesComplete) {
      const parameters = new URLSearchParams({
        maxRecords: String(this.options.maxRecordsPerPage ?? 10_000),
      });
      if (current.nextLocator) parameters.set("locator", current.nextLocator);
      const response = await this.options.client.request(
        `${this.options.client.dataPath(`/jobs/query/${encodeURIComponent(current.jobId)}/results`)}?${parameters}`,
        { headers: { accept: "text/csv" }, signal: input.signal },
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      await atomicWrite(join(parts, `${current.page}.csv`), bytes);
      const rawRows = response.headers.get("sforce-numberofrecords");
      const pageRows = rawRows === null ? Number.NaN : Number.parseInt(rawRows, 10);
      if (!Number.isSafeInteger(pageRows) || pageRows < 0) {
        throw new SalesforceExportError(
          `${input.sourceApiName}: Bulk result page omitted its row count`,
        );
      }
      const locator = response.headers.get("sforce-locator");
      if (locator && locator !== "null" && locator === current.nextLocator) {
        throw new SalesforceExportError(
          `${input.sourceApiName}: Bulk result locator did not advance`,
        );
      }
      current.rows += pageRows;
      current.page += 1;
      current.pagesComplete = locator === null || locator === "null";
      current.nextLocator = current.pagesComplete ? null : locator;
      await this.writeCheckpoint(input.root, input.checkpoint);
    }
    const merged = await mergeCsvParts({
      partsDirectory: parts,
      pages: current.page,
      destination: dataPath,
    });
    current.sha256 = merged.sha256;
    current.state = "complete";
    await this.writeCheckpoint(input.root, input.checkpoint);
    return current;
  }

  async export(input: {
    directory: string;
    resume?: boolean;
    signal?: AbortSignal;
  }): Promise<RecordConnectorExportResult> {
    const root = resolve(input.directory);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await Promise.all([
      mkdir(join(root, "data"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, "describe"), { recursive: true, mode: 0o700 }),
      mkdir(join(root, ".pages"), { recursive: true, mode: 0o700 }),
    ]);
    const checkpoint = await this.loadCheckpoint(root, input.resume === true);
    const schema = await this.schemaPlan(input.signal);
    const describes = schema.mappings.map((mapping) => {
      const describe = this.describes.get(mapping.sourceObject);
      if (!describe) {
        throw new SalesforceExportError(
          `${mapping.sourceObject}: reviewed Salesforce describe is missing`,
        );
      }
      return describe;
    });
    const artifacts = [];
    for (const describe of describes) {
      const mapping = schema.mappings.find(
        (candidate) => candidate.sourceObject === describe.name,
      )!;
      await atomicWrite(
        join(root, "describe", `${mapping.targetObject}.json`),
        `${JSON.stringify(describe, null, 2)}\n`,
      );
      const object = await this.exportObject({
        root,
        checkpoint,
        sourceApiName: describe.name,
        targetApiName: mapping.targetObject,
        fields: sourceFields(schema, describe.name),
        signal: input.signal,
      });
      artifacts.push({
        source_api_name: describe.name,
        object_api_name: mapping.targetObject,
        data_path: `data/${mapping.targetObject}.csv`,
        describe_path: `describe/${mapping.targetObject}.json`,
        expected_rows: object.rows,
        sha256: object.sha256,
        watermark: { system_modstamp: checkpoint.startedAt },
      });
    }
    const manifest = parseRecordsArtifactManifest({
      format: "openneko.records.artifact.v1",
      source: {
        kind: "salesforce",
        instance_id: this.options.sourceInstanceId,
        mode: this.options.mode,
      },
      generated_at: this.now().toISOString(),
      watermark: { system_modstamp: checkpoint.startedAt },
      objects: artifacts,
    });
    await atomicWrite(
      join(root, "export-manifest.json"),
      serializeRecordsArtifactManifest(manifest),
    );
    await stat(join(root, "export-manifest.json"));
    return { directory: root, manifest };
  }

  async delta(input: {
    sourceApiName: string;
    watermark: Record<string, unknown> | null;
    signal?: AbortSignal;
  }): Promise<RecordConnectorDelta> {
    const sourceApiName = assertApiName(input.sourceApiName, "Salesforce object");
    const selected = await this.selectedObjects(input.signal);
    if (!selected.includes(sourceApiName)) {
      throw new SalesforceExportError(`${sourceApiName}: object is not in this connector`);
    }
    const describe = await this.describe(sourceApiName, input.signal);
    const schema = buildSalesforceAppSchema({
      app: this.options.app,
      label: this.options.label,
      purpose: this.options.purpose,
      mode: this.options.mode,
      describes: [describe],
    });
    const selectedFields = new Set(sourceFields(schema, sourceApiName));
    selectedFields.add("SystemModstamp");
    selectedFields.add("IsDeleted");
    selectedFields.add("Id");
    const watermark = input.watermark?.system_modstamp;
    if (watermark !== undefined && (typeof watermark !== "string" || Number.isNaN(Date.parse(watermark)))) {
      throw new SalesforceExportError("Salesforce delta watermark is invalid");
    }
    const lowerBound =
      typeof watermark === "string" ? new Date(watermark).toISOString() : "1970-01-01T00:00:00.000Z";
    const query = `SELECT ${[...selectedFields].join(", ")} FROM ${sourceApiName} WHERE SystemModstamp > ${lowerBound} ORDER BY SystemModstamp ASC`;
    let path = `${this.options.client.dataPath("/queryAll")}?q=${encodeURIComponent(query)}`;
    const records: Array<Record<string, unknown>> = [];
    const deletedIds: string[] = [];
    let nextWatermark = lowerBound;
    while (path) {
      const page = await this.options.client.json<QueryResult>(path, { signal: input.signal });
      for (const source of page.records ?? []) {
        const record = normalizedRecord(describe, source);
        const stamp = record.SystemModstamp;
        if (typeof stamp === "string" && Date.parse(stamp) > Date.parse(nextWatermark)) {
          nextWatermark = new Date(stamp).toISOString();
        }
        if (record.IsDeleted === true) {
          if (typeof record.Id === "string") deletedIds.push(record.Id);
        } else {
          records.push(record);
        }
      }
      if (page.done !== false || !page.nextRecordsUrl) break;
      if (!page.nextRecordsUrl.startsWith("/services/")) {
        throw new SalesforceExportError("Salesforce delta pagination path is invalid");
      }
      path = page.nextRecordsUrl;
    }
    return {
      sourceApiName,
      records,
      deletedIds,
      nextWatermark: { system_modstamp: nextWatermark },
    };
  }
}
