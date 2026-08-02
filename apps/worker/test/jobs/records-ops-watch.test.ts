import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runRecordsOpsWatch,
  type RecordsOpsWatchDependencies,
} from "../../src/jobs/records-ops-watch.js";
import {
  recordsBackupHealthLevel,
  requestRecordsBackupHealth,
  type RecordsBackupHealthSample,
} from "../../src/jobs/records-ops-health.js";

const sample = {
  sampledAt: "2026-08-02T20:00:00Z",
  metadata: { totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedPercent: 50 },
  records: { totalBytes: 100 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, usedPercent: 91 },
  staging: { totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedPercent: 50 },
};

const now = new Date("2026-08-02T20:00:00Z");
const healthyBackup: RecordsBackupHealthSample = {
  sampledAt: now.toISOString(),
  state: "ready",
  lastBackupAt: "2026-08-02T10:00:00Z",
  lastBackupSet: "20260802T100000Z",
  lastVerificationAt: "2026-08-01T20:00:00Z",
  lastVerificationStatus: "succeeded",
  error: null,
};

function dependencies(
  overrides: Partial<RecordsOpsWatchDependencies> = {},
): RecordsOpsWatchDependencies {
  return {
    sample: vi.fn().mockResolvedValue(sample),
    sampleBackup: vi.fn().mockResolvedValue(healthyBackup),
    previous: vi.fn().mockResolvedValue({ records: "ok" }),
    persist: vi.fn().mockResolvedValue(undefined),
    previousCheck: vi.fn().mockResolvedValue(null),
    persistCheck: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    now: () => now,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("records operations watcher", () => {
  it("persists every sample and alerts only on a watermark transition", async () => {
    const deps = dependencies();
    await expect(runRecordsOpsWatch("org-a", deps)).resolves.toMatchObject({
      levels: { records: "critical" },
      findings: 1,
    });
    expect(deps.persist).toHaveBeenCalledWith(
      "org-a",
      sample,
      expect.objectContaining({ records: "critical" }),
    );
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ mood: "act", topic: "capacity_watermark" }),
    );
  });

  it("emits a recovery finding when headroom returns", async () => {
    const healthy = {
      ...sample,
      records: {
        totalBytes: 100 * 1024 ** 3,
        freeBytes: 10 * 1024 ** 3,
        usedPercent: 50,
      },
    };
    const deps = dependencies({
      sample: vi.fn().mockResolvedValue(healthy),
      previous: vi.fn().mockResolvedValue({ records: "critical" }),
    });
    await runRecordsOpsWatch("org-a", deps);
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ mood: "good", title: "records storage recovered" }),
    );
  });

  it("records sidecar failure and raises an actionable finding", async () => {
    const deps = dependencies({
      sample: vi.fn().mockRejectedValue(new Error("sidecar timeout")),
      previous: vi.fn().mockResolvedValue({ records: "ok" }),
    });
    await expect(runRecordsOpsWatch("org-a", deps)).rejects.toThrow("sidecar timeout");
    expect(deps.persist).toHaveBeenCalledWith(
      "org-a",
      null,
      expect.objectContaining({ records: "unavailable" }),
    );
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ mood: "act", topic: "capacity_monitor" }),
    );
  });

  it("classifies missing, aging, and fresh backup protection", () => {
    expect(
      recordsBackupHealthLevel(
        { ...healthyBackup, lastBackupAt: null },
        now,
      ),
    ).toBe("critical");
    expect(
      recordsBackupHealthLevel(
        { ...healthyBackup, lastBackupAt: "2026-08-01T12:00:00Z" },
        now,
      ),
    ).toBe("warning");
    expect(recordsBackupHealthLevel(healthyBackup, now)).toBe("ok");
  });

  it("reads the bounded backup status contract from the private sidecar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          state: "ready",
          last_backup_at: healthyBackup.lastBackupAt,
          last_backup_set: healthyBackup.lastBackupSet,
          last_verification_at: healthyBackup.lastVerificationAt,
          last_verification_status: "succeeded",
          verification: { large: "nested report is intentionally omitted" },
        }),
      ),
    );

    await expect(requestRecordsBackupHealth()).resolves.toMatchObject({
      state: "ready",
      lastBackupSet: "20260802T100000Z",
      lastVerificationStatus: "succeeded",
      error: null,
    });
  });

  it("publishes backup freshness only when its durable level changes", async () => {
    const staleBackup = {
      ...healthyBackup,
      lastVerificationAt: "2026-07-20T20:00:00Z",
    };
    const deps = dependencies({
      sampleBackup: vi.fn().mockResolvedValue(staleBackup),
      previous: vi.fn().mockResolvedValue({
        metadata: "ok",
        records: "critical",
        staging: "ok",
      }),
      previousCheck: vi.fn(async (_orgId, checkName) =>
        checkName === "backup:whole_deployment" ? "ok" : null,
      ),
    });

    await expect(runRecordsOpsWatch("org-a", deps)).resolves.toMatchObject({
      backupLevel: "critical",
      findings: 1,
    });
    expect(deps.persistCheck).toHaveBeenCalledWith(
      "org-a",
      "backup:whole_deployment",
      "critical",
      expect.objectContaining({ lastBackupSet: "20260802T100000Z" }),
      now,
    );
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ mood: "act", topic: "backup_freshness" }),
    );
  });

  it("alerts on stalled records work and emits a recovery transition", async () => {
    const stalled = {
      sampledAt: now.toISOString(),
      stalled: [
        {
          source: "records" as const,
          id: "import-1",
          kind: "records_import",
          status: "running",
          updatedAt: "2026-08-02T18:00:00Z",
          error: null,
        },
      ],
      failedRecent: [],
    };
    const deps = dependencies({
      sampleJobs: vi.fn().mockResolvedValue(stalled),
      previous: vi.fn().mockResolvedValue({
        metadata: "ok",
        records: "critical",
        staging: "ok",
      }),
      previousCheck: vi.fn(async (_orgId, checkName) =>
        checkName === "jobs:records" ? "ok" : null,
      ),
    });
    await expect(runRecordsOpsWatch("org-a", deps)).resolves.toMatchObject({
      jobsLevel: "critical",
      findings: 1,
    });
    expect(deps.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({
        title: "1 records job appears stalled",
        topic: "records_job_health",
      }),
    );

    const recovered = dependencies({
      sampleJobs: vi.fn().mockResolvedValue({
        sampledAt: now.toISOString(),
        stalled: [],
        failedRecent: [],
      }),
      previous: vi.fn().mockResolvedValue({
        metadata: "ok",
        records: "critical",
        staging: "ok",
      }),
      previousCheck: vi.fn(async (_orgId, checkName) =>
        checkName === "jobs:records" ? "critical" : null,
      ),
    });
    await runRecordsOpsWatch("org-a", recovered);
    expect(recovered.publish).toHaveBeenCalledWith(
      "org-a",
      expect.objectContaining({ mood: "good", title: "Records job health recovered" }),
    );
  });
});
