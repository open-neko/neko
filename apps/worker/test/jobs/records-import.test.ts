import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RecordImportExecutor, RecordImportReport } from "@neko/records";
import { runRecordsImport } from "../../src/jobs/records-import";

describe("records import job", () => {
  it("passes the durable pg-boss job identity into the executor lease", async () => {
    const report: RecordImportReport = {
      status: "succeeded",
      importRunId: "import-1",
      appId: "equipment",
      objectApiName: "loan",
      sourceName: "loans.csv",
      sourceRows: 2,
      inserted: 2,
      rejected: 0,
      duplicates: 0,
      batches: 1,
      reconciled: true,
    };
    const execute = vi.fn(async () => report);
    const assertStorage = vi.fn().mockResolvedValue(undefined);

    const result = await runRecordsImport(
      { execute } as unknown as RecordImportExecutor,
      {} as Pool,
      {
        orgId: "org-a",
        importRunId: "import-1",
        actorUserId: "admin-1",
      },
      {
        leaseOwner: "records-import-job:boss-job-1",
        getRun: vi.fn().mockResolvedValue({
          appId: "equipment",
          status: "planned",
          plan: { source: { bytes: 128 } },
        }),
        assertStorage,
      },
    );

    expect(execute).toHaveBeenCalledWith({
      orgId: "org-a",
      importRunId: "import-1",
      actorUserId: "admin-1",
      leaseOwner: "records-import-job:boss-job-1",
    });
    expect(assertStorage).toHaveBeenCalledWith(384);
    expect(result).toEqual({
      appId: "equipment",
      report,
      terminalError: null,
    });
  });
});
