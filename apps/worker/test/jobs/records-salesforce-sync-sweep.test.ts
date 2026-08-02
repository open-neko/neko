import { describe, expect, it, vi } from "vitest";
import {
  runRecordsSalesforceSyncSweep,
  type SalesforceSyncSweepDependencies,
} from "../../src/jobs/records-salesforce-sync-sweep.js";

const NOW = new Date("2026-08-02T12:30:00.000Z");

function state(overrides: Record<string, unknown> = {}) {
  return {
    orgId: "org-a",
    appId: "crm",
    appStatus: "active",
    mode: "mirror" as const,
    sourceInstanceId: "salesforce-production",
    exportActionRequestId: "00000000-0000-4000-a000-000000000861",
    objects: [
      {
        sourceApiName: "Account",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      },
    ],
    enabled: true,
    intervalMinutes: 15,
    status: "succeeded",
    lastEnqueuedAt: "2026-08-02T12:00:00.000Z",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    apiBudget: null,
    cutover: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<SalesforceSyncSweepDependencies> = {},
): SalesforceSyncSweepDependencies {
  return {
    candidates: vi.fn().mockResolvedValue([{ orgId: "org-a", appId: "crm" }]),
    getState: vi.fn().mockResolvedValue(state()),
    createOrResumeJob: vi
      .fn()
      .mockResolvedValue("00000000-0000-4000-a000-000000000862"),
    enqueue: vi.fn().mockResolvedValue("boss-job-1"),
    markEnqueued: vi.fn().mockResolvedValue(undefined),
    now: vi.fn().mockReturnValue(NOW),
    ...overrides,
  };
}

describe("Salesforce sync schedule sweep", () => {
  it("queues each due active mirror once", async () => {
    const deps = dependencies();
    await expect(runRecordsSalesforceSyncSweep(deps)).resolves.toEqual({
      inspected: 1,
      queued: 1,
      skipped: 0,
    });
    expect(deps.enqueue).toHaveBeenCalledWith({
      processingJobId: "00000000-0000-4000-a000-000000000862",
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
    });
    expect(deps.markEnqueued).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "crm" }),
      NOW.toISOString(),
    );
  });

  it("skips schedules that are not due, disabled, or already primary", async () => {
    for (const candidate of [
      state({ lastEnqueuedAt: "2026-08-02T12:20:00.000Z" }),
      state({ enabled: false }),
      state({ mode: "primary" }),
    ]) {
      const deps = dependencies({ getState: vi.fn().mockResolvedValue(candidate) });
      await expect(runRecordsSalesforceSyncSweep(deps)).resolves.toMatchObject({
        queued: 0,
        skipped: 1,
      });
      expect(deps.createOrResumeJob).not.toHaveBeenCalled();
    }
  });

  it("re-enqueues an orphaned queued job even before the next interval", async () => {
    const deps = dependencies({
      getState: vi.fn().mockResolvedValue(
        state({ status: "queued", lastEnqueuedAt: "2026-08-02T12:29:00.000Z" }),
      ),
    });
    await expect(runRecordsSalesforceSyncSweep(deps)).resolves.toMatchObject({ queued: 1 });
    expect(deps.createOrResumeJob).toHaveBeenCalledOnce();
  });

  it("isolates malformed app metadata from the rest of the sweep", async () => {
    const deps = dependencies({
      candidates: vi.fn().mockResolvedValue([
        { orgId: "org-a", appId: "broken" },
        { orgId: "org-a", appId: "crm" },
      ]),
      getState: vi
        .fn()
        .mockRejectedValueOnce(new Error("invalid connector"))
        .mockResolvedValueOnce(state()),
    });
    await expect(runRecordsSalesforceSyncSweep(deps)).resolves.toEqual({
      inspected: 2,
      queued: 1,
      skipped: 1,
    });
  });
});
