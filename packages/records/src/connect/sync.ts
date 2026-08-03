import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { SalesforceObjectMapping } from "./salesforce/schema";
import type { RecordConnectorDelta } from "./types";
import type { JsonObject } from "../types";
import type {
  RecordWriteExecutor,
  RecordWriteRequest,
  RecordWriteResult,
} from "../write/executor";

export type RecordSyncCursor = {
  orgId: string;
  appId: string;
  sourceInstanceId: string;
  objectApiName: string;
  watermark: JsonObject;
  lastBatchHash: string;
  updatedAt: Date;
};

type RawCursor = {
  org_id: string;
  app_id: string;
  source_instance_id: string;
  object_api_name: string;
  watermark: JsonObject;
  last_batch_hash: string;
  updated_at: Date;
};

export class RecordSyncCursorConflictError extends Error {
  readonly code = "records_sync_cursor_conflict";

  constructor() {
    super("records sync cursor advanced concurrently; reload before applying this delta");
    this.name = "RecordSyncCursorConflictError";
  }
}

export class RecordSyncDeltaError extends Error {
  readonly code = "records_sync_delta_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordSyncDeltaError";
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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function mapCursor(row: RawCursor): RecordSyncCursor {
  return {
    orgId: row.org_id,
    appId: row.app_id,
    sourceInstanceId: row.source_instance_id,
    objectApiName: row.object_api_name,
    watermark: row.watermark,
    lastBatchHash: row.last_batch_hash,
    updatedAt: row.updated_at,
  };
}

const CURSOR_COLUMNS = `org_id, app_id, source_instance_id, object_api_name,
  watermark, last_batch_hash, updated_at`;

export async function getRecordSyncCursor(
  pool: Pool,
  input: {
    orgId: string;
    appId: string;
    sourceInstanceId: string;
    objectApiName: string;
  },
): Promise<RecordSyncCursor | null> {
  const result = await pool.query<RawCursor>(
    `select ${CURSOR_COLUMNS} from engine.sync_cursor
     where org_id = $1 and app_id = $2 and source_instance_id = $3
       and object_api_name = $4`,
    [input.orgId, input.appId, input.sourceInstanceId, input.objectApiName],
  );
  return result.rows[0] ? mapCursor(result.rows[0]) : null;
}

/** Seed import watermarks once; a resumed import never moves a live cursor backwards. */
export async function seedRecordSyncCursor(
  pool: Pool,
  input: {
    orgId: string;
    appId: string;
    sourceInstanceId: string;
    objectApiName: string;
    watermark: JsonObject;
    manifestHash: string;
  },
): Promise<RecordSyncCursor> {
  const result = await pool.query<RawCursor>(
    `insert into engine.sync_cursor
       (org_id, app_id, source_instance_id, object_api_name, watermark, last_batch_hash)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (org_id, app_id, source_instance_id, object_api_name) do update
       set updated_at = engine.sync_cursor.updated_at
     returning ${CURSOR_COLUMNS}`,
    [
      input.orgId,
      input.appId,
      input.sourceInstanceId,
      input.objectApiName,
      JSON.stringify(input.watermark),
      `manifest:${input.manifestHash}`,
    ],
  );
  return mapCursor(result.rows[0]!);
}

export async function advanceRecordSyncCursor(
  pool: Pool,
  input: {
    orgId: string;
    appId: string;
    sourceInstanceId: string;
    objectApiName: string;
    expectedWatermark: JsonObject;
    nextWatermark: JsonObject;
    batchHash: string;
  },
): Promise<RecordSyncCursor> {
  if (!/^[0-9a-f]{64}$/.test(input.batchHash)) {
    throw new RecordSyncDeltaError("records sync batch hash is invalid");
  }
  const result = await pool.query<RawCursor>(
    `update engine.sync_cursor
     set watermark = $6::jsonb, last_batch_hash = $7, updated_at = now()
     where org_id = $1 and app_id = $2 and source_instance_id = $3
       and object_api_name = $4 and watermark = $5::jsonb
     returning ${CURSOR_COLUMNS}`,
    [
      input.orgId,
      input.appId,
      input.sourceInstanceId,
      input.objectApiName,
      JSON.stringify(input.expectedWatermark),
      JSON.stringify(input.nextWatermark),
      input.batchHash,
    ],
  );
  if (result.rows[0]) return mapCursor(result.rows[0]);
  const current = await getRecordSyncCursor(pool, input);
  if (
    current?.lastBatchHash === input.batchHash &&
    canonicalJson(current.watermark) === canonicalJson(input.nextWatermark)
  ) {
    return current;
  }
  throw new RecordSyncCursorConflictError();
}

function mappedRecord(
  record: Record<string, unknown>,
  mapping: SalesforceObjectMapping,
): { id: string; fields: Record<string, unknown> } {
  let id = "";
  const fields: Record<string, unknown> = {};
  for (const field of mapping.fields) {
    if (field.targetField === null) continue;
    const value = record[field.sourceField];
    if (field.targetField === "id") {
      if (typeof value === "string") id = value.trim();
    } else {
      fields[field.targetField] = value ?? null;
    }
  }
  if (!id || id.length > 512) {
    throw new RecordSyncDeltaError(
      `${mapping.sourceObject}: delta record is missing its source id`,
    );
  }
  return { id, fields };
}

function actionRequestId(input: {
  batchHash: string;
  operation: "upsert" | "delete";
  index: number;
  id: string;
}): string {
  return `records-sync:${sha256({
    format: "openneko.records.sync-mutation.v1",
    ...input,
  })}`;
}

export type RecordDeltaSyncResult = {
  appId: string;
  objectApiName: string;
  sourceApiName: string;
  batchHash: string;
  upserts: number;
  deletes: number;
  noOps: number;
  replays: number;
  cursor: RecordSyncCursor;
};

/** Apply one connector page through C4 and advance only after every receipt succeeds. */
export async function applyRecordConnectorDelta(input: {
  pool: Pool;
  writer: Pick<RecordWriteExecutor, "execute">;
  orgId: string;
  appId: string;
  sourceInstanceId: string;
  objectApiName: string;
  expectedWatermark: JsonObject;
  delta: RecordConnectorDelta;
  mapping: SalesforceObjectMapping;
}): Promise<RecordDeltaSyncResult> {
  if (
    input.mapping.sourceObject !== input.delta.sourceApiName ||
    input.mapping.targetObject !== input.objectApiName
  ) {
    throw new RecordSyncDeltaError("connector delta does not match its approved object mapping");
  }
  const records = input.delta.records.map((record) => mappedRecord(record, input.mapping));
  const deletedIds = input.delta.deletedIds.map((id) => id.trim());
  if (deletedIds.some((id) => !id || id.length > 512)) {
    throw new RecordSyncDeltaError("connector delta contains an invalid deleted id");
  }
  const batchHash = sha256({
    format: "openneko.records.sync-batch.v1",
    orgId: input.orgId,
    appId: input.appId,
    sourceInstanceId: input.sourceInstanceId,
    objectApiName: input.objectApiName,
    sourceApiName: input.delta.sourceApiName,
    expectedWatermark: input.expectedWatermark,
    nextWatermark: input.delta.nextWatermark,
    records,
    deletedIds,
  });
  const lockIdentity = `${input.orgId}:${input.appId}:${input.sourceInstanceId}:${input.objectApiName}`;
  const lockClient = await input.pool.connect();
  await lockClient.query(
    "select pg_advisory_lock(hashtextextended($1, 0))",
    [lockIdentity],
  );
  try {
    const current = await getRecordSyncCursor(input.pool, input);
    if (
      !current ||
      canonicalJson(current.watermark) !== canonicalJson(input.expectedWatermark)
    ) {
      if (
        current?.lastBatchHash === batchHash &&
        canonicalJson(current.watermark) === canonicalJson(input.delta.nextWatermark)
      ) {
        return {
          appId: input.appId,
          objectApiName: input.objectApiName,
          sourceApiName: input.delta.sourceApiName,
          batchHash,
          upserts: records.length,
          deletes: deletedIds.length,
          noOps: 0,
          replays: records.length + deletedIds.length,
          cursor: current,
        };
      }
      throw new RecordSyncCursorConflictError();
    }
  const actor = {
    userId: `urn:openneko:sync:${input.sourceInstanceId}`,
    role: "admin" as const,
  };
  const system = { kind: "sync" as const, sourceInstanceId: input.sourceInstanceId };
  const results: RecordWriteResult[] = [];
  for (const [index, record] of records.entries()) {
    const request: RecordWriteRequest = {
      actionRequestId: actionRequestId({
        batchHash,
        operation: "upsert",
        index,
        id: record.id,
      }),
      orgId: input.orgId,
      appId: input.appId,
      objectApiName: input.objectApiName,
      operation: "upsert",
      id: record.id,
      fields: record.fields,
      actor,
      system,
    };
    results.push(await input.writer.execute(request));
  }
  for (const [index, id] of deletedIds.entries()) {
    results.push(
      await input.writer.execute({
        actionRequestId: actionRequestId({
          batchHash,
          operation: "delete",
          index,
          id,
        }),
        orgId: input.orgId,
        appId: input.appId,
        objectApiName: input.objectApiName,
        operation: "delete",
        id,
        actor,
        system,
      }),
    );
  }
  const cursor = await advanceRecordSyncCursor(input.pool, {
    orgId: input.orgId,
    appId: input.appId,
    sourceInstanceId: input.sourceInstanceId,
    objectApiName: input.objectApiName,
    expectedWatermark: input.expectedWatermark,
    nextWatermark: input.delta.nextWatermark,
    batchHash,
  });
    return {
      appId: input.appId,
      objectApiName: input.objectApiName,
      sourceApiName: input.delta.sourceApiName,
      batchHash,
      upserts: records.length,
      deletes: deletedIds.length,
      noOps: results.filter((result) => result.noOp).length,
      replays: results.filter((result) => result.replayed || result.recovered).length,
      cursor,
    };
  } finally {
    await lockClient
      .query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockIdentity])
      .finally(() => lockClient.release());
  }
}
