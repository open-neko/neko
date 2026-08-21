import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const metadata = {
    query: vi.fn(async (sql: string) => {
      void sql;
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const records = {
    query: vi.fn(async (sql: string) => {
      void sql;
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return {
    metadata,
    records,
    writeLocalConfig: vi.fn(),
    reconnectPool: vi.fn(async () => undefined),
    reconnectRecords: vi.fn(async () => undefined),
    hasCustomPassword: vi.fn(() => true),
    fetch: vi.fn(async () => new Response("restarting", { status: 202 })),
  };
});

vi.mock("@neko/db", () => ({
  buildRecordsPoolConfig: () => ({ user: "records" }),
  hasCustomPassword: mocks.hasCustomPassword,
  pool: () => ({ connect: async () => mocks.metadata }),
  reconnectPool: mocks.reconnectPool,
  writeLocalConfig: mocks.writeLocalConfig,
}));

vi.mock("@/lib/records", () => ({
  getWebRecordsPool: () => ({ connect: async () => mocks.records }),
  reconnectWebRecordsRuntime: mocks.reconnectRecords,
}));

vi.mock("@/lib/admin-auth", () => ({
  requireAdminActor: async () => ({ userId: "admin-1", role: "admin" }),
  isDenied: () => false,
}));

import { GET, POST } from "@/app/api/admin/change-password/route";

function request(password: string): Request {
  return new Request("http://localhost/api/admin/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

describe("admin database password rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadata.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.records.query.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("rotates both database roles before persisting and reconnecting", async () => {
    const response = await POST(request("A-safe-passphrase-2026") as never);

    expect(response.status).toBe(200);
    expect(mocks.metadata.query.mock.calls.map(([sql]) => sql)).toEqual([
      // The advisory lock brackets rotation AND config persistence, so two
      // concurrent rotations can't leave the file and the role divergent.
      "select pg_advisory_lock(hashtext('openneko.password-rotation'))",
      "begin",
      "alter role neko with password 'A-safe-passphrase-2026'",
      "commit",
      "select pg_advisory_unlock(hashtext('openneko.password-rotation'))",
    ]);
    expect(mocks.records.query.mock.calls.map(([sql]) => sql)).toEqual([
      "begin",
      "alter role records with password 'A-safe-passphrase-2026'",
      "commit",
    ]);
    expect(mocks.writeLocalConfig).toHaveBeenCalledWith({
      pg: { password: "A-safe-passphrase-2026" },
      recordsPg: { password: "A-safe-passphrase-2026" },
    });
    expect(mocks.reconnectRecords).toHaveBeenCalledOnce();
    expect(mocks.reconnectPool).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/admin/reconnect",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rolls back both transactions and never persists a partial rotation", async () => {
    mocks.records.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("alter role")) throw new Error("records unavailable");
      return { rows: [], rowCount: 0 };
    });

    const response = await POST(request("A-safe-passphrase-2026") as never);

    expect(response.status).toBe(500);
    expect(mocks.metadata.query).toHaveBeenCalledWith("rollback");
    expect(mocks.records.query).toHaveBeenCalledWith("rollback");
    expect(mocks.writeLocalConfig).not.toHaveBeenCalled();
  });

  it("reports setup complete only when both managed passwords exist", async () => {
    const response = await GET();
    await expect(response.json()).resolves.toEqual({ changed: true });
  });
});
