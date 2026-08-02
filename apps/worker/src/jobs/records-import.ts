import type { RecordsImportPayload } from "@neko/db/jobs";
import type { Pool } from "pg";
import {
  failRecordImportRun,
  RecordImportExecutor,
  RecordImportTerminalError,
} from "@neko/records";

export async function runRecordsImport(
  executor: RecordImportExecutor,
  pool: Pool,
  payload: RecordsImportPayload,
): Promise<void> {
  try {
    const report = await executor.execute(payload);
    console.log(
      `[records-import] run=${payload.importRunId} status=${report.status} inserted=${report.inserted} rejected=${report.rejected}`,
    );
  } catch (error) {
    if (error instanceof RecordImportTerminalError) {
      await failRecordImportRun(
        pool,
        {
          orgId: payload.orgId,
          id: payload.importRunId,
          error: { code: error.code, message: error.message },
        },
      );
      console.warn(
        `[records-import] run=${payload.importRunId} failed terminally: ${error.message}`,
      );
      return;
    }
    throw error;
  }
}
