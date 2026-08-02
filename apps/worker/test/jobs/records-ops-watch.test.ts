import { describe, expect, it, vi } from "vitest";
import {
  runRecordsOpsWatch,
  type RecordsOpsWatchDependencies,
} from "../../src/jobs/records-ops-watch.js";

const sample = {
  sampledAt: "2026-08-02T20:00:00Z",
  metadata: { totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedPercent: 50 },
  records: { totalBytes: 100 * 1024 ** 3, freeBytes: 9 * 1024 ** 3, usedPercent: 91 },
  staging: { totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedPercent: 50 },
};

function dependencies(
  overrides: Partial<RecordsOpsWatchDependencies> = {},
): RecordsOpsWatchDependencies {
  return {
    sample: vi.fn().mockResolvedValue(sample),
    previous: vi.fn().mockResolvedValue({ records: "ok" }),
    persist: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("records operations storage watcher", () => {
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
});
