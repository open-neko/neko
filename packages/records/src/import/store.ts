import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { RecordImportPlan } from "./plan";
import { verifyRecordImportPlanHash } from "./plan";

export type RecordImportStatus =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type RecordImportRun = {
  id: string;
  orgId: string;
  appId: string;
  actionRequestId: string;
  sourceInstanceId: string | null;
  status: RecordImportStatus;
  planHash: string;
  currentStage: string | null;
  plan: RecordImportPlan;
  progress: Record<string, unknown> | null;
  report: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type RecordImportBatchReceipt = {
  importRunId: string;
  objectApiName: string;
  batchNo: number;
  batchHash: string;
  rowCount: number;
  committedAt: Date;
};

export type RecordImportRejectInput = {
  objectApiName: string;
  rowNumber: number;
  rowHash: string;
  reasonCode: string;
  reason: string;
  sourceRow: Record<string, string>;
};

type RawRun = {
  id: string;
  org_id: string;
  app_id: string;
  action_request_id: string;
  source_instance_id: string | null;
  status: RecordImportStatus;
  plan_hash: string;
  current_stage: string | null;
  result: {
    plan?: RecordImportPlan;
    progress?: Record<string, unknown>;
    report?: Record<string, unknown>;
  } | null;
  error: Record<string, unknown> | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type RawReceipt = {
  import_run_id: string;
  object_api_name: string;
  batch_no: number;
  batch_hash: string;
  row_count: number;
  committed_at: Date;
};

const RUN_COLUMNS = `id, org_id, app_id, action_request_id,
  source_instance_id, status, plan_hash, current_stage, result, error,
  cancel_requested_at, created_at, updated_at`;

function mapRun(row: RawRun): RecordImportRun {
  const plan = row.result?.plan;
  if (!plan) throw new Error(`records import run ${row.id} has no durable plan`);
  verifyRecordImportPlanHash(plan);
  return {
    id: row.id,
    orgId: row.org_id,
    appId: row.app_id,
    actionRequestId: row.action_request_id,
    sourceInstanceId: row.source_instance_id,
    status: row.status,
    planHash: row.plan_hash,
    currentStage: row.current_stage,
    plan,
    progress: row.result?.progress ?? null,
    report: row.result?.report ?? null,
    error: row.error,
    cancelRequestedAt: row.cancel_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapReceipt(row: RawReceipt): RecordImportBatchReceipt {
  return {
    importRunId: row.import_run_id,
    objectApiName: row.object_api_name,
    batchNo: row.batch_no,
    batchHash: row.batch_hash,
    rowCount: row.row_count,
    committedAt: row.committed_at,
  };
}

async function transaction<T>(client: PoolClient, operation: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function createRecordImportRun(
  pool: Pool,
  input: {
    orgId: string;
    actionRequestId: string;
    plan: RecordImportPlan;
    sourceInstanceId?: string | null;
    id?: string;
  },
): Promise<RecordImportRun> {
  verifyRecordImportPlanHash(input.plan);
  const id = input.id ?? randomUUID();
  const result = await pool.query<RawRun>(
    `insert into engine.import_run
       (id, org_id, app_id, action_request_id, source_instance_id,
        status, plan_hash, current_stage, result)
     values ($1::uuid, $2, $3, $4, $5, 'planned', $6, 'manifest', $7::jsonb)
     on conflict (action_request_id) do update
       set updated_at = engine.import_run.updated_at
     returning ${RUN_COLUMNS}`,
    [
      id,
      input.orgId,
      input.plan.appId,
      input.actionRequestId,
      input.sourceInstanceId ?? null,
      input.plan.planHash,
      JSON.stringify({ plan: input.plan }),
    ],
  );
  const run = mapRun(result.rows[0]!);
  if (
    run.orgId !== input.orgId ||
    run.appId !== input.plan.appId ||
    run.planHash !== input.plan.planHash
  ) {
    throw new Error("records import action request was reused with a different plan");
  }
  return run;
}

export async function getRecordImportRun(
  pool: Pool,
  input: { orgId: string; id: string },
): Promise<RecordImportRun | null> {
  const result = await pool.query<RawRun>(
    `select ${RUN_COLUMNS} from engine.import_run where org_id = $1 and id = $2::uuid`,
    [input.orgId, input.id],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function startRecordImportRun(
  pool: Pool,
  input: { orgId: string; id: string },
): Promise<RecordImportRun> {
  const result = await pool.query<RawRun>(
    `update engine.import_run
     set status = 'running', current_stage = 'load', error = null, updated_at = now()
     where org_id = $1 and id = $2::uuid and status in ('planned', 'running')
     returning ${RUN_COLUMNS}`,
    [input.orgId, input.id],
  );
  if (!result.rows[0]) {
    const existing = await getRecordImportRun(pool, input);
    if (existing?.status === "succeeded" || existing?.status === "cancelled") return existing;
    throw new Error(`records import run ${input.id} cannot start from ${existing?.status ?? "missing"}`);
  }
  return mapRun(result.rows[0]);
}

export async function updateRecordImportProgress(
  pool: Pool,
  input: {
    orgId: string;
    id: string;
    stage: string;
    progress: Record<string, unknown>;
  },
): Promise<void> {
  const result = await pool.query(
    `update engine.import_run
     set current_stage = $3,
         result = jsonb_set(coalesce(result, '{}'::jsonb), '{progress}', $4::jsonb, true),
         updated_at = now()
     where org_id = $1 and id = $2::uuid and status = 'running'`,
    [input.orgId, input.id, input.stage, JSON.stringify(input.progress)],
  );
  if (result.rowCount !== 1) throw new Error(`records import run ${input.id} is not running`);
}

export async function finishRecordImportRun(
  pool: Pool,
  input: {
    orgId: string;
    id: string;
    report: Record<string, unknown>;
  },
): Promise<RecordImportRun> {
  const result = await pool.query<RawRun>(
    `update engine.import_run
     set status = 'succeeded', current_stage = 'report', error = null,
         result = jsonb_set(coalesce(result, '{}'::jsonb), '{report}', $3::jsonb, true),
         updated_at = now()
     where org_id = $1 and id = $2::uuid and status = 'running'
     returning ${RUN_COLUMNS}`,
    [input.orgId, input.id, JSON.stringify(input.report)],
  );
  if (!result.rows[0]) {
    const existing = await getRecordImportRun(pool, input);
    if (existing?.status === "succeeded") return existing;
    throw new Error(`records import run ${input.id} could not finish`);
  }
  return mapRun(result.rows[0]);
}

export async function failRecordImportRun(
  pool: Pool,
  input: { orgId: string; id: string; error: Record<string, unknown> },
): Promise<void> {
  await pool.query(
    `update engine.import_run
     set status = 'failed', error = $3::jsonb, updated_at = now()
     where org_id = $1 and id = $2::uuid and status in ('planned', 'running')`,
    [input.orgId, input.id, JSON.stringify(input.error)],
  );
}

export async function cancelRecordImportRun(
  pool: Pool,
  input: { orgId: string; id: string },
): Promise<RecordImportRun | null> {
  const result = await pool.query<RawRun>(
    `update engine.import_run
     set status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()),
         current_stage = 'cancelled', updated_at = now()
     where org_id = $1 and id = $2::uuid and status in ('planned', 'running')
     returning ${RUN_COLUMNS}`,
    [input.orgId, input.id],
  );
  return result.rows[0]
    ? mapRun(result.rows[0])
    : getRecordImportRun(pool, input);
}

export async function getRecordImportReceipt(
  pool: Pool,
  input: { runId: string; objectApiName: string; batchHash: string },
): Promise<RecordImportBatchReceipt | null> {
  const result = await pool.query<RawReceipt>(
    `select import_run_id, object_api_name, batch_no, batch_hash,
            row_count, committed_at
     from engine.import_batch_receipt
     where import_run_id = $1::uuid and object_api_name = $2 and batch_hash = $3`,
    [input.runId, input.objectApiName, input.batchHash],
  );
  return result.rows[0] ? mapReceipt(result.rows[0]) : null;
}

export async function getRecordImportReceiptAtBatch(
  pool: Pool,
  input: { runId: string; objectApiName: string; batchNo: number },
): Promise<RecordImportBatchReceipt | null> {
  const result = await pool.query<RawReceipt>(
    `select import_run_id, object_api_name, batch_no, batch_hash,
            row_count, committed_at
     from engine.import_batch_receipt
     where import_run_id = $1::uuid and object_api_name = $2 and batch_no = $3`,
    [input.runId, input.objectApiName, input.batchNo],
  );
  return result.rows[0] ? mapReceipt(result.rows[0]) : null;
}

async function upsertReject(
  client: PoolClient,
  runId: string,
  reject: RecordImportRejectInput,
): Promise<void> {
  await client.query(
    `insert into engine.import_reject
       (import_run_id, object_api_name, row_number, row_hash,
        reason_code, reason, source_row)
     values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (import_run_id, object_api_name, row_number) do update
       set row_hash = excluded.row_hash, reason_code = excluded.reason_code,
           reason = excluded.reason, source_row = excluded.source_row`,
    [
      runId,
      reject.objectApiName,
      reject.rowNumber,
      reject.rowHash,
      reject.reasonCode,
      reject.reason,
      JSON.stringify(reject.sourceRow),
    ],
  );
}

export async function recordRecordImportRejects(
  pool: Pool,
  input: { runId: string; rejects: RecordImportRejectInput[] },
): Promise<void> {
  if (input.rejects.length === 0) return;
  const client = await pool.connect();
  try {
    await transaction(client, async () => {
      for (const reject of input.rejects) await upsertReject(client, input.runId, reject);
    });
  } finally {
    client.release();
  }
}

/** Checkpoint a source chunk that intentionally wrote no app rows. */
export async function recordEmptyImportBatch(
  pool: Pool,
  input: {
    runId: string;
    objectApiName: string;
    batchNo: number;
    batchHash: string;
    rejects: RecordImportRejectInput[];
  },
): Promise<RecordImportBatchReceipt> {
  const client = await pool.connect();
  try {
    return await transaction(client, async () => {
      for (const reject of input.rejects) await upsertReject(client, input.runId, reject);
      const result = await client.query<RawReceipt>(
        `insert into engine.import_batch_receipt
           (import_run_id, object_api_name, batch_no, batch_hash, row_count)
         values ($1::uuid, $2, $3, $4, 0)
         on conflict (import_run_id, object_api_name, batch_no) do update
           set batch_hash = engine.import_batch_receipt.batch_hash
         returning import_run_id, object_api_name, batch_no, batch_hash,
                   row_count, committed_at`,
        [input.runId, input.objectApiName, input.batchNo, input.batchHash],
      );
      const receipt = mapReceipt(result.rows[0]!);
      if (receipt.batchHash !== input.batchHash) {
        throw new Error("records import batch checkpoint identity mismatch");
      }
      return receipt;
    });
  } finally {
    client.release();
  }
}

export async function summarizeRecordImportRun(
  pool: Pool,
  runId: string,
): Promise<{
  inserted: number;
  rejected: number;
  duplicates: number;
  batches: number;
} > {
  const result = await pool.query<{
    inserted: string;
    batches: string;
    rejected: string;
    duplicates: string;
  }>(
    `select
       coalesce((select sum(row_count) from engine.import_batch_receipt
                 where import_run_id = $1::uuid), 0)::text as inserted,
       (select count(*) from engine.import_batch_receipt
        where import_run_id = $1::uuid)::text as batches,
       (select count(*) from engine.import_reject
        where import_run_id = $1::uuid)::text as rejected,
       (select count(*) from engine.import_reject
        where import_run_id = $1::uuid and reason_code = 'duplicate')::text as duplicates`,
    [runId],
  );
  const row = result.rows[0]!;
  return {
    inserted: Number(row.inserted),
    batches: Number(row.batches),
    rejected: Number(row.rejected),
    duplicates: Number(row.duplicates),
  };
}

