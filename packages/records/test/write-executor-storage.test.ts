import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { RecordsGraphjinTransport } from "../src/graphjin/client.js";
import { RecordWriteExecutor } from "../src/write/executor.js";

describe("records write storage backpressure", () => {
  it("fails before registry or GraphJin access when the hard stop is active", async () => {
    const failure = Object.assign(new Error("records storage is hard stop"), {
      code: "records_storage_backpressure",
      retryable: true,
    });
    const graphjin = { execute: vi.fn() } as unknown as RecordsGraphjinTransport;
    const executor = new RecordWriteExecutor({
      pool: { query: vi.fn() } as unknown as Pool,
      graphjin,
      serviceToken: vi.fn().mockResolvedValue("token"),
      leaseOwner: "test",
      recordSourceWrite: vi.fn().mockResolvedValue(undefined),
      assertWritesAllowed: vi.fn().mockRejectedValue(failure),
    });

    await expect(
      executor.execute({
        actionRequestId: "action-1",
        orgId: "org-a",
        appId: "crm",
        objectApiName: "account",
        operation: "create",
        actor: { userId: "admin-1", role: "admin" },
        fields: { name: "Acme" },
      }),
    ).rejects.toBe(failure);
    expect(graphjin.execute).not.toHaveBeenCalled();
  });
});
