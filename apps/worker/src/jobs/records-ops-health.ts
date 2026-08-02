import {
  and,
  db,
  eq,
  gte,
  inArray,
  lt,
  or,
  processing_job,
} from "@neko/db";
import type { Pool } from "pg";
import type { RecordsStorageLevel } from "../records/storage-health.js";

const ACTIVE_JOB_STATUSES = ["queued", "running", "retrying"] as const;
const METADATA_RECORDS_JOB_KINDS = [
  "records_salesforce_export",
  "records_salesforce_sync",
  "records_salesforce_cutover",
] as const;
const JOB_STALL_MS = 30 * 60 * 1_000;
const FAILED_JOB_WINDOW_MS = 24 * 60 * 60 * 1_000;
const BACKUP_WARNING_MS = 30 * 60 * 60 * 1_000;
const BACKUP_CRITICAL_MS = 36 * 60 * 60 * 1_000;
const VERIFICATION_WARNING_MS = 7 * 24 * 60 * 60 * 1_000;
const VERIFICATION_CRITICAL_MS = 8 * 24 * 60 * 60 * 1_000;

export type RecordsBackupHealthSample = {
  sampledAt: string;
  state: string;
  lastBackupAt: string | null;
  lastBackupSet: string | null;
  lastVerificationAt: string | null;
  lastVerificationStatus: string | null;
  error: string | null;
};

export type RecordsJobHealthIssue = {
  source: "metadata" | "records";
  id: string;
  kind: string;
  status: string;
  updatedAt: string;
  error: string | null;
};

export type RecordsJobHealthSample = {
  sampledAt: string;
  stalled: RecordsJobHealthIssue[];
  failedRecent: RecordsJobHealthIssue[];
};

function backupBaseUrl(): string {
  return (process.env.OPENNEKO_BACKUP_URL ?? "http://127.0.0.1:9470").replace(
    /\/+$/,
    "",
  );
}

export async function requestRecordsBackupHealth(): Promise<RecordsBackupHealthSample> {
  const response = await fetch(`${backupBaseUrl()}/v1/backups/status`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`backup status returned HTTP ${response.status}`);
  }
  const value = (await response.json()) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backup status returned an invalid payload");
  }
  const status = value as Record<string, unknown>;
  const nullableString = (key: string): string | null =>
    typeof status[key] === "string" && status[key] ? String(status[key]) : null;
  return {
    sampledAt: new Date().toISOString(),
    state: nullableString("state") ?? "unknown",
    lastBackupAt: nullableString("last_backup_at"),
    lastBackupSet: nullableString("last_backup_set"),
    lastVerificationAt: nullableString("last_verification_at"),
    lastVerificationStatus: nullableString("last_verification_status"),
    error: nullableString("error"),
  };
}

function issue(input: {
  source: "metadata" | "records";
  id: unknown;
  kind: unknown;
  status: unknown;
  updatedAt: unknown;
  error: unknown;
}): RecordsJobHealthIssue {
  const updatedAt =
    input.updatedAt instanceof Date
      ? input.updatedAt.toISOString()
      : new Date(String(input.updatedAt)).toISOString();
  return {
    source: input.source,
    id: String(input.id),
    kind: String(input.kind),
    status: String(input.status),
    updatedAt,
    error:
      input.error == null
        ? null
        : (typeof input.error === "string"
            ? input.error
            : JSON.stringify(input.error)
          ).slice(0, 1_000),
  };
}

export async function sampleRecordsJobHealth(
  recordsPool: Pool,
  orgId: string,
  now = new Date(),
): Promise<RecordsJobHealthSample> {
  const stalledBefore = new Date(now.getTime() - JOB_STALL_MS);
  const failedAfter = new Date(now.getTime() - FAILED_JOB_WINDOW_MS);
  const metadataRows = await db()
    .select({
      id: processing_job.id,
      kind: processing_job.kind,
      status: processing_job.status,
      updatedAt: processing_job.updated_at,
      error: processing_job.error,
    })
    .from(processing_job)
    .where(
      and(
        eq(processing_job.org_id, orgId),
        inArray(processing_job.kind, [...METADATA_RECORDS_JOB_KINDS]),
        or(
          and(
            inArray(processing_job.status, [...ACTIVE_JOB_STATUSES]),
            lt(processing_job.updated_at, stalledBefore),
          ),
          and(
            eq(processing_job.status, "failed"),
            gte(processing_job.updated_at, failedAfter),
          ),
        ),
      ),
    )
    .limit(50);
  const importRows = (
    await recordsPool.query<{
      id: string;
      status: string;
      updated_at: Date | string;
      error: unknown;
    }>(
      `select id::text, status, updated_at, error
         from engine.import_run
        where org_id = $1
          and ((status = 'running' and updated_at < $2)
            or (status = 'failed' and updated_at >= $3))
        order by updated_at desc
        limit 50`,
      [orgId, stalledBefore, failedAfter],
    )
  ).rows;
  const issues = [
    ...metadataRows.map((row) => issue({ source: "metadata", ...row })),
    ...importRows.map((row) =>
      issue({
        source: "records",
        id: row.id,
        kind: "records_import",
        status: row.status,
        updatedAt: row.updated_at,
        error: row.error,
      }),
    ),
  ];
  return {
    sampledAt: now.toISOString(),
    stalled: issues.filter((value) => value.status !== "failed"),
    failedRecent: issues.filter((value) => value.status === "failed"),
  };
}

export function recordsHealthAge(value: string | null, now: Date): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, now.getTime() - timestamp)
    : Number.POSITIVE_INFINITY;
}

export function recordsBackupHealthLevel(
  sample: RecordsBackupHealthSample,
  now: Date,
): RecordsStorageLevel {
  const backupAge = recordsHealthAge(sample.lastBackupAt, now);
  const verificationAge = recordsHealthAge(sample.lastVerificationAt, now);
  if (
    sample.state === "failed" ||
    sample.error ||
    sample.lastVerificationStatus === "failed" ||
    backupAge > BACKUP_CRITICAL_MS ||
    verificationAge > VERIFICATION_CRITICAL_MS
  ) {
    return "critical";
  }
  if (
    backupAge > BACKUP_WARNING_MS ||
    verificationAge > VERIFICATION_WARNING_MS
  ) {
    return "warning";
  }
  return "ok";
}
