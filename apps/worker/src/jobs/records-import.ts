import type { RecordsImportPayload } from "@neko/db/jobs";
import type { Pool } from "pg";
import {
  failRecordImportRun,
  getRecordImportRun,
  RecordImportExecutor,
  RecordImportTerminalError,
  type RecordImportReport,
  type RecordImportRun,
} from "@neko/records";
import { createRecordsStorageMonitor } from "../records/storage-health.js";

export type RecordsImportJobOptions = {
  leaseOwner?: string;
  getRun?: (
    pool: Pool,
    input: { orgId: string; id: string },
  ) => Promise<RecordImportRun | null>;
  assertStorage?: (recordsBytes: number) => Promise<void>;
};

export type RecordsImportJobResult = {
  appId: string;
  report: RecordImportReport | null;
  terminalError: Record<string, unknown> | null;
};

export async function runRecordsImport(
  executor: RecordImportExecutor,
  pool: Pool,
  payload: RecordsImportPayload,
  options: RecordsImportJobOptions = {},
): Promise<RecordsImportJobResult> {
  const run = await (options.getRun ?? getRecordImportRun)(pool, {
    orgId: payload.orgId,
    id: payload.importRunId,
  });
  if (!run) throw new Error(`records import run ${payload.importRunId} was not found`);
  if (run.status !== "succeeded" && run.status !== "cancelled") {
    const recordsBytes = run.plan.source.bytes * 3;
    if (!Number.isSafeInteger(recordsBytes)) {
      throw new Error("records import footprint exceeds the supported range");
    }
    await (
      options.assertStorage ??
      (async (requiredBytes: number) => {
        await createRecordsStorageMonitor().assertBulkAllowed({
          recordsBytes: requiredBytes,
        });
      })
    )(recordsBytes);
  }
  try {
    const report = await executor.execute({
      ...payload,
      ...(options.leaseOwner ? { leaseOwner: options.leaseOwner } : {}),
    });
    console.log(
      `[records-import] run=${payload.importRunId} status=${report.status} inserted=${report.inserted} rejected=${report.rejected}`,
    );
    return { appId: run.appId, report, terminalError: null };
  } catch (error) {
    if (error instanceof RecordImportTerminalError) {
      const terminalError = { code: error.code, message: error.message };
      await failRecordImportRun(
        pool,
        {
          orgId: payload.orgId,
          id: payload.importRunId,
          error: terminalError,
        },
      );
      console.warn(
        `[records-import] run=${payload.importRunId} failed terminally: ${error.message}`,
      );
      return { appId: run.appId, report: null, terminalError };
    }
    throw error;
  }
}
