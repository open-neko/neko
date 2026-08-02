import { describe, expect, it, vi } from "vitest";
import {
  estimateSalesforceFootprint,
  RecordsStorageBackpressureError,
  RecordsStorageMonitor,
  type RecordsStorageThresholds,
} from "../../src/records/storage-health.js";

const GIB = 1024 ** 3;
const thresholds: RecordsStorageThresholds = {
  warningPercent: 80,
  criticalPercent: 90,
  hardStopPercent: 95,
  warningFreeBytes: 5 * GIB,
  criticalFreeBytes: 2 * GIB,
  hardStopFreeBytes: GIB,
};

function response(freeBytes: number) {
  const totalBytes = 100 * GIB;
  const value = {
    totalBytes,
    freeBytes,
    usedPercent: ((totalBytes - freeBytes) / totalBytes) * 100,
  };
  return new Response(
    JSON.stringify({
      sampledAt: "2026-08-02T12:00:00.000Z",
      metadata: value,
      records: value,
      staging: value,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("records storage watermarks", () => {
  it("rejects bulk work when its projected footprint crosses critical", async () => {
    const monitor = new RecordsStorageMonitor({
      endpoint: "http://records-ops:9465",
      fallbackPath: "/unused",
      thresholds,
      fetch: vi.fn().mockResolvedValue(response(12 * GIB)),
    });
    await expect(
      monitor.assertBulkAllowed({ recordsBytes: 3 * GIB }),
    ).rejects.toMatchObject({
      code: "records_storage_backpressure",
      volume: "records",
      level: "critical",
      retryable: true,
    });
  });

  it("keeps interactive writes open at critical and stops them at hard-stop", async () => {
    const critical = new RecordsStorageMonitor({
      endpoint: "http://records-ops:9465",
      fallbackPath: "/unused",
      thresholds,
      fetch: vi.fn().mockResolvedValue(response(8 * GIB)),
    });
    await expect(critical.assertInteractiveWritesAllowed()).resolves.toBeDefined();

    const hard = new RecordsStorageMonitor({
      endpoint: "http://records-ops:9465",
      fallbackPath: "/unused",
      thresholds,
      fetch: vi.fn().mockResolvedValue(response(900 * 1024 ** 2)),
    });
    await expect(hard.assertInteractiveWritesAllowed()).rejects.toBeInstanceOf(
      RecordsStorageBackpressureError,
    );
  });

  it("estimates connected staging plus a three-times database footprint", () => {
    expect(
      estimateSalesforceFootprint({
        salesforce_inventory: {
          objects: [{ estimatedRows: 100_000, fields: 20 }],
        },
      }),
    ).toEqual({ stagingBytes: 128_000_000, recordsBytes: 384_000_000 });
  });

  it("coalesces capacity reads across a burst of record writes", async () => {
    const read = vi.fn().mockResolvedValue(response(50 * GIB));
    const monitor = new RecordsStorageMonitor({
      endpoint: "http://records-ops:9465",
      fallbackPath: "/unused",
      thresholds,
      fetch: read,
    });
    await Promise.all([
      monitor.assertInteractiveWritesAllowed(),
      monitor.assertInteractiveWritesAllowed(),
    ]);
    await monitor.assertInteractiveWritesAllowed();
    expect(read).toHaveBeenCalledOnce();
  });
});
