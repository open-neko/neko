import { describe, expect, it, vi } from "vitest";
import {
  runRecordsBackupVerification,
  type BackupVerificationDependencies,
  type BackupVerificationReport,
} from "../../src/jobs/records-backup-verify.js";

const report: BackupVerificationReport = {
  format: "openneko.backup-verification.v1",
  status: "succeeded",
  backup_set: "20260802T194658Z",
  completed_at: "2026-08-02T19:48:10Z",
  databases: [
    { stanza: "openneko-metadata", probe: { action_requests: 10 } },
    { stanza: "openneko-records", probe: { record_changes: 20 } },
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
});
