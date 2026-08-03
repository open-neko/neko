import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestBackupVerification,
  runRecordsBackupVerification,
  type BackupVerificationDependencies,
  type BackupVerificationReport,
} from "../../src/jobs/records-backup-verify.js";

afterEach(() => vi.unstubAllGlobals());

const report: BackupVerificationReport = {
  format: "openneko.backup-verification.v1",
  status: "succeeded",
  backup_set: "20260802T194658Z",
  completed_at: "2026-08-02T19:48:10Z",
  databases: [
    { stanza: "openneko-metadata", probe: { action_requests: 10 } },
    {
      stanza: "openneko-records",
      probe: {
        record_changes: 20,
        record_change_sample: { rows_sampled: 20, sha256: "a".repeat(64) },
      },
    },
  ],
  config_snapshot: { status: "decrypted_and_checksum_verified" },
};

function dependencies(
  overrides: Partial<BackupVerificationDependencies> = {},
): BackupVerificationDependencies {
  return {
    verify: vi.fn().mockResolvedValue(report),
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("weekly records backup verification", () => {
  it("publishes a healthy Briefing finding only after a proven paired restore", async () => {
    const deps = dependencies();
    await expect(runRecordsBackupVerification("org-a", deps)).resolves.toEqual(report);
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({
        status: "succeeded",
        mood: "good",
        payload: report,
      }),
    );
  });

  it("publishes an actionable finding and retries when verification fails", async () => {
    const deps = dependencies({
      verify: vi.fn().mockRejectedValue(new Error("records row count regressed")),
    });
    await expect(runRecordsBackupVerification("org-a", deps)).rejects.toThrow(
      "records row count regressed",
    );
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({
        status: "failed",
        mood: "act",
        body: "records row count regressed",
      }),
    );
  });

  it("rejects duplicate database stanzas and an unverified config snapshot", async () => {
    for (const invalid of [
      {
        ...report,
        databases: [report.databases[0], report.databases[0]],
      },
      {
        ...report,
        config_snapshot: { status: "decrypted_only" },
      },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(invalid), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      await expect(requestBackupVerification()).rejects.toThrow(
        "did not prove both database restores",
      );
    }
  });

  it("rejects a restore report without a valid records integrity sample", async () => {
    for (const sample of [undefined, { rows_sampled: 20, sha256: "short" }]) {
      const invalid = {
        ...report,
        databases: report.databases.map((database) =>
          database.stanza === "openneko-records"
            ? {
                ...database,
                probe: {
                  record_changes: 20,
                  ...(sample ? { record_change_sample: sample } : {}),
                },
              }
            : database,
        ),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(invalid), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
      await expect(requestBackupVerification()).rejects.toThrow(/sample integrity/i);
    }
  });
});
