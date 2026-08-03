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
  SalesforceApiError,
  type SalesforceApiBudgetSnapshot,
} from "./client";
import { normalizeSalesforceId } from "./id";
import { parseRecordsCsv } from "../../import/csv";
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
  strategy?: "bulk2" | "pk_chunk" | "rest";
  fallbackReason?: string | null;
  restNextPath?: string | null;
  pkSeedBatchId?: string | null;
  pkResults?: Array<{ batchId: string; resultId: string }>;
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

type BulkV1Job = {
  id?: string;
  state?: string;
  errorMessage?: string;
};

type BulkV1Batch = {
  id?: string;
  state?: string;
  stateMessage?: string;
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

class SalesforceBulkQueryRejectedError extends SalesforceExportError {
  constructor(message: string) {
    super(message);
    this.name = "SalesforceBulkQueryRejectedError";
  }
}

class SalesforcePkChunkRejectedError extends SalesforceExportError {
  constructor(message: string) {
    super(message);
    this.name = "SalesforcePkChunkRejectedError";
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

function fallbackReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function canUseExportFallback(error: unknown): boolean {
  if (
    error instanceof SalesforceBulkQueryRejectedError ||
    error instanceof SalesforcePkChunkRejectedError
  ) {
    return true;
  }
  return (
    error instanceof SalesforceApiError &&
    !error.retryable &&
    error.status !== null &&
    [400, 404, 405, 415].includes(error.status)
  );
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function restCsv(
  fields: string[],
  records: Array<Record<string, unknown>>,
): Uint8Array {
  const lines = [
    fields.map(csvCell).join(","),
    ...records.map((record) => fields.map((field) => csvCell(record[field])).join(",")),
  ];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

function bulkV1Batches(value: unknown): BulkV1Batch[] {
  if (Array.isArray(value)) return value as BulkV1Batch[];
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>).batchInfo;
  if (Array.isArray(raw)) return raw as BulkV1Batch[];
  return raw && typeof raw === "object" ? [raw as BulkV1Batch] : [];
}

function bulkV1ResultIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && Boolean(item));
  }
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>).result;
  if (typeof raw === "string" && raw) return [raw];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
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
    strategy: "bulk2",
    fallbackReason: null,
    restNextPath: null,
    pkSeedBatchId: null,
    pkResults: [],
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
  private readonly counts = new Map<string, number | null>();
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
      restRecordThreshold?: number;
      pkChunkSize?: number;
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
    const restThreshold = options.restRecordThreshold ?? 2_000;
    if (!Number.isSafeInteger(restThreshold) || restThreshold < 0) {
      throw new Error("Salesforce REST export threshold must be a non-negative integer");
    }
    const pkChunkSize = options.pkChunkSize ?? 100_000;
    if (
      !Number.isSafeInteger(pkChunkSize) ||
      pkChunkSize < 1 ||
      pkChunkSize > 250_000
    ) {
      throw new Error("Salesforce PK chunk size must be between 1 and 250000");
    }
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private async sleep(milliseconds: number): Promise<void> {
    await (this.options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
      milliseconds,
    );
  }

  budgetSnapshot(): SalesforceApiBudgetSnapshot | null {
    return this.options.client.budgetSnapshot();
  }

  restoreBudget(snapshot: SalesforceApiBudgetSnapshot | null): void {
    this.options.client.restoreBudget(snapshot);
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
    if (this.counts.has(sourceApiName)) {
      return this.counts.get(sourceApiName) ?? null;
    }
    const query = `SELECT count() FROM ${quotedSoqlIdentifier(sourceApiName)}`;
    const result = await this.options.client.json<QueryResult>(
      `${this.options.client.dataPath("/query")}?q=${encodeURIComponent(query)}`,
      { signal },
    );
    const count = Number.isSafeInteger(result.totalSize) && Number(result.totalSize) >= 0
      ? Number(result.totalSize)
      : null;
    this.counts.set(sourceApiName, count);
    return count;
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
        throw new SalesforceBulkQueryRejectedError(
          `Salesforce Bulk job ${jobId} ${job.state.toLowerCase()}: ${job.errorMessage ?? "unknown error"}`,
        );
      }
      await this.sleep(this.options.pollIntervalMs ?? 2_000);
    }
    throw new SalesforceExportError(`Salesforce Bulk job ${jobId} exceeded its poll budget`);
  }

  private resetExportStrategy(
    current: ExportObjectCheckpoint,
    strategy: "pk_chunk" | "rest",
    reason: string,
  ): void {
    current.strategy = strategy;
    current.fallbackReason = reason;
    current.jobId = null;
    current.state = "pending";
    current.nextLocator = null;
    current.pagesComplete = false;
    current.page = 0;
    current.rows = 0;
    current.sha256 = null;
    current.restNextPath = null;
    current.pkSeedBatchId = null;
    current.pkResults = [];
  }

  private async exportBulk2Pages(input: {
    root: string;
    parts: string;
    checkpoint: ExportCheckpoint;
    current: ExportObjectCheckpoint;
    sourceApiName: string;
    fields: string[];
    signal?: AbortSignal;
  }): Promise<void> {
    const current = input.current;
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
      await atomicWrite(join(input.parts, `${current.page}.csv`), bytes);
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
  }

  private async waitForPkChunkBatches(
    jobId: string,
    seedBatchId: string,
    signal?: AbortSignal,
  ): Promise<BulkV1Batch[]> {
    const maximum = this.options.maxPolls ?? 720;
    for (let poll = 0; poll < maximum; poll += 1) {
      const raw = await this.options.client.json<unknown>(
        this.options.client.asyncPath(`/job/${encodeURIComponent(jobId)}/batch`),
        { signal },
      );
      const batches = bulkV1Batches(raw).filter(
        (batch): batch is Required<Pick<BulkV1Batch, "id" | "state">> & BulkV1Batch =>
          typeof batch.id === "string" &&
          Boolean(batch.id) &&
          typeof batch.state === "string" &&
          Boolean(batch.state),
      );
      const failed = batches.find(
        (batch) => batch.state === "Failed" || batch.state === "Aborted",
      );
      if (failed) {
        throw new SalesforcePkChunkRejectedError(
          `Salesforce PK chunk batch ${failed.id} ${failed.state.toLowerCase()}: ${failed.stateMessage ?? "unknown error"}`,
        );
      }
      const active = batches.some((batch) =>
        ["Queued", "InProgress"].includes(batch.state),
      );
      const completed = batches.filter((batch) => batch.state === "Completed");
      const seed = batches.find((batch) => batch.id === seedBatchId);
      if (!active && completed.length > 0 && seed) return completed;
      await this.sleep(this.options.pollIntervalMs ?? 2_000);
    }
    throw new SalesforceExportError(
      `Salesforce PK chunk job ${jobId} exceeded its poll budget`,
    );
  }

  private async exportPkChunkPages(input: {
    root: string;
    parts: string;
    checkpoint: ExportCheckpoint;
    current: ExportObjectCheckpoint;
    sourceApiName: string;
    fields: string[];
    signal?: AbortSignal;
  }): Promise<void> {
    const current = input.current;
    if (!current.jobId || !current.pkSeedBatchId) {
      const query = `SELECT ${input.fields.join(", ")} FROM ${quotedSoqlIdentifier(input.sourceApiName)}`;
      const job = await this.options.client.json<BulkV1Job>(
        this.options.client.asyncPath("/job"),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "sforce-enable-pkchunking": `chunkSize=${this.options.pkChunkSize ?? 100_000}`,
          },
          body: JSON.stringify({
            operation: "queryAll",
            object: input.sourceApiName,
            contentType: "CSV",
            concurrencyMode: "Parallel",
          }),
          signal: input.signal,
        },
      );
      if (typeof job.id !== "string" || !job.id) {
        throw new SalesforcePkChunkRejectedError(
          `${input.sourceApiName}: PK chunking did not return a job id`,
        );
      }
      const batch = await this.options.client.json<BulkV1Batch>(
        this.options.client.asyncPath(`/job/${encodeURIComponent(job.id)}/batch`),
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "text/csv" },
          body: query,
          signal: input.signal,
        },
      );
      if (typeof batch.id !== "string" || !batch.id) {
        throw new SalesforcePkChunkRejectedError(
          `${input.sourceApiName}: PK chunking did not return a seed batch id`,
        );
      }
      await this.options.client.json<BulkV1Job>(
        this.options.client.asyncPath(`/job/${encodeURIComponent(job.id)}`),
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ state: "Closed" }),
          signal: input.signal,
        },
      );
      current.jobId = job.id;
      current.pkSeedBatchId = batch.id;
      current.state = "querying";
      await this.writeCheckpoint(input.root, input.checkpoint);
    }

    if (!current.pkResults || current.pkResults.length === 0) {
      const batches = await this.waitForPkChunkBatches(
        current.jobId,
        current.pkSeedBatchId,
        input.signal,
      );
      const results: Array<{ batchId: string; resultId: string }> = [];
      for (const batch of batches) {
        const raw = await this.options.client.json<unknown>(
          this.options.client.asyncPath(
            `/job/${encodeURIComponent(current.jobId)}/batch/${encodeURIComponent(batch.id!)}/result`,
          ),
          { signal: input.signal },
        );
        for (const resultId of bulkV1ResultIds(raw)) {
          results.push({ batchId: batch.id!, resultId });
        }
      }
      results.sort(
        (left, right) =>
          left.batchId.localeCompare(right.batchId) ||
          left.resultId.localeCompare(right.resultId),
      );
      if (results.length === 0) {
        throw new SalesforcePkChunkRejectedError(
          `${input.sourceApiName}: PK chunking produced no result sets`,
        );
      }
      current.pkResults = results;
      current.state = "pages";
      await this.writeCheckpoint(input.root, input.checkpoint);
    }

    while (!current.pagesComplete) {
      const result = current.pkResults[current.page];
      if (!result) {
        current.pagesComplete = true;
        await this.writeCheckpoint(input.root, input.checkpoint);
        break;
      }
      const response = await this.options.client.request(
        this.options.client.asyncPath(
          `/job/${encodeURIComponent(current.jobId)}/batch/${encodeURIComponent(result.batchId)}/result/${encodeURIComponent(result.resultId)}`,
        ),
        { headers: { accept: "text/csv" }, signal: input.signal },
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const parsed = parseRecordsCsv(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      await atomicWrite(join(input.parts, `${current.page}.csv`), bytes);
      current.rows += parsed.rows.length;
      current.page += 1;
      current.pagesComplete = current.page >= current.pkResults.length;
      await this.writeCheckpoint(input.root, input.checkpoint);
    }
  }

  private async exportRestPages(input: {
    root: string;
    parts: string;
    checkpoint: ExportCheckpoint;
    current: ExportObjectCheckpoint;
    sourceApiName: string;
    fields: string[];
    signal?: AbortSignal;
  }): Promise<void> {
    const current = input.current;
    current.state = "pages";
    while (!current.pagesComplete) {
      const query = `SELECT ${input.fields.join(", ")} FROM ${quotedSoqlIdentifier(input.sourceApiName)}`;
      const path =
        current.restNextPath ??
        `${this.options.client.dataPath("/queryAll")}?q=${encodeURIComponent(query)}`;
      const page = await this.options.client.json<QueryResult>(path, {
        signal: input.signal,
      });
      const records = Array.isArray(page.records) ? page.records : [];
      await atomicWrite(
        join(input.parts, `${current.page}.csv`),
        restCsv(input.fields, records),
      );
      const next = page.done === false ? page.nextRecordsUrl : null;
      if (
        page.done === false &&
        (typeof next !== "string" ||
          !next.startsWith("/services/") ||
          next === path)
      ) {
        throw new SalesforceExportError(
          `${input.sourceApiName}: REST query pagination path is invalid`,
        );
      }
      current.rows += records.length;
      current.page += 1;
      current.pagesComplete = page.done !== false;
      current.restNextPath = current.pagesComplete ? null : next;
      await this.writeCheckpoint(input.root, input.checkpoint);
    }
  }

  private async exportObject(input: {
    root: string;
    checkpoint: ExportCheckpoint;
    sourceApiName: string;
    targetApiName: string;
    fields: string[];
    estimatedRows: number | null;
    signal?: AbortSignal;
  }): Promise<ExportObjectCheckpoint> {
    const current =
      input.checkpoint.objects[input.sourceApiName] ??
      checkpointObject(input.sourceApiName, input.targetApiName);
    if (current.targetApiName !== input.targetApiName) {
      throw new SalesforceExportError(`${input.sourceApiName}: target changed after export began`);
    }
    current.strategy ??= "bulk2";
    current.pkResults ??= [];
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

    const restThreshold = this.options.restRecordThreshold ?? 2_000;
    if (
      current.state === "pending" &&
      current.page === 0 &&
      !current.jobId &&
      input.estimatedRows !== null &&
      input.estimatedRows <= restThreshold
    ) {
      this.resetExportStrategy(current, "rest", "small_object");
      await this.writeCheckpoint(input.root, input.checkpoint);
    }

    if (current.strategy === "bulk2") {
      try {
        await this.exportBulk2Pages({ ...input, parts, current });
      } catch (error) {
        if (!canUseExportFallback(error)) throw error;
        this.resetExportStrategy(current, "pk_chunk", fallbackReason(error));
        await this.writeCheckpoint(input.root, input.checkpoint);
      }
    }
    if (current.strategy === "pk_chunk") {
      try {
        await this.exportPkChunkPages({ ...input, parts, current });
      } catch (error) {
        if (!canUseExportFallback(error)) throw error;
        this.resetExportStrategy(current, "rest", fallbackReason(error));
        await this.writeCheckpoint(input.root, input.checkpoint);
      }
    }
    if (current.strategy === "rest") {
      await this.exportRestPages({ ...input, parts, current });
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
      const estimatedRows =
        (this.options.restRecordThreshold ?? 2_000) > 0
          ? await this.count(describe.name, input.signal)
          : null;
      const object = await this.exportObject({
        root,
        checkpoint,
        sourceApiName: describe.name,
        targetApiName: mapping.targetObject,
        fields: sourceFields(schema, describe.name),
        estimatedRows,
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
