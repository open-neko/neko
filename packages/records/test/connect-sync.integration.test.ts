import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  applyRecordConnectorDelta,
  getRecordSyncCursor,
  RecordSyncCursorConflictError,
  seedRecordSyncCursor,
} from "../src/connect/sync";
import type { RecordWriteRequest, RecordWriteResult } from "../src/write/executor";

async function recordsDbReachable(): Promise<boolean> {
  const probe = new pg.Pool(buildRecordsPoolConfig());
  try {
    await probe.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

const reachable = await recordsDbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) console.warn("[records-sync] skipping: records Postgres unreachable");

describeIfDb("records connector delta receipts", () => {
  const database = `records_sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    pool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool });
    await pool.query(`
      insert into engine.record_app (org_id, app_id, label, status)
      values ('org-a', 'crm', 'CRM', 'active')
    `);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it("seeds once, applies deterministic C4 writes, and advances after every receipt", async () => {
    const initial = { system_modstamp: "2026-08-01T00:00:00.000Z" };
    const seeded = await seedRecordSyncCursor(pool, {
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
      objectApiName: "account",
      watermark: initial,
      manifestHash: "a".repeat(64),
    });
    expect(seeded).toMatchObject({ watermark: initial, lastBatchHash: `manifest:${"a".repeat(64)}` });

    const seen = new Set<string>();
    const execute = vi.fn(async (request: RecordWriteRequest): Promise<RecordWriteResult> => {
      const replayed = seen.has(request.actionRequestId);
      seen.add(request.actionRequestId);
      return {
        actionRequestId: request.actionRequestId,
        appId: request.appId,
        objectApiName: request.objectApiName,
        tableName: "crm__account",
        id: request.id!,
        operation: request.operation === "delete" ? "delete" : "update",
        mutationId: request.actionRequestId,
        replayed,
        recovered: false,
        ...(request.operation === "delete" ? { noOp: true } : {}),
      };
    });
    const writer = { execute };
    const delta = {
      sourceApiName: "Account",
      records: [
        {
          Id: "001A000010khO8JIAU",
          Name: "Acme",
          SystemModstamp: "2026-08-02T10:00:00.000Z",
        },
      ],
      deletedIds: ["001A000010khO8IIAU"],
      nextWatermark: { system_modstamp: "2026-08-02T10:00:00.000Z" },
    };
    const mapping = {
      sourceObject: "Account",
      targetObject: "account" as never,
      fields: [
        { sourceField: "Id", targetField: "id" as const, skippedReason: null },
        { sourceField: "Name", targetField: "name" as never, skippedReason: null },
        {
          sourceField: "SystemModstamp",
          targetField: "systemmodstamp" as never,
          skippedReason: null,
        },
      ],
    };
    const first = await applyRecordConnectorDelta({
      pool,
      writer: writer as never,
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
      objectApiName: "account",
      expectedWatermark: initial,
      delta,
      mapping,
    });
    expect(first).toMatchObject({ upserts: 1, deletes: 1, noOps: 1, replays: 0 });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        operation: "upsert",
        id: "001A000010khO8JIAU",
        fields: { name: "Acme", systemmodstamp: "2026-08-02T10:00:00.000Z" },
        actor: { role: "admin", userId: "urn:openneko:sync:salesforce-production" },
        system: { kind: "sync", sourceInstanceId: "salesforce-production" },
      }),
    );
    expect(first.cursor.watermark).toEqual(delta.nextWatermark);

    // Exact job replay is recognized from the target cursor before writes.
    await expect(
      applyRecordConnectorDelta({
        pool,
        writer: writer as never,
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        objectApiName: "account",
        expectedWatermark: initial,
        delta,
        mapping,
      }),
    ).resolves.toMatchObject({ replays: 2, batchHash: first.batchHash });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale batch before issuing any business writes", async () => {
    const execute = vi.fn();
    await expect(
      applyRecordConnectorDelta({
        pool,
        writer: { execute } as never,
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        objectApiName: "account",
        expectedWatermark: { system_modstamp: "2020-01-01T00:00:00.000Z" },
        delta: {
          sourceApiName: "Account",
          records: [],
          deletedIds: [],
          nextWatermark: { system_modstamp: "2026-08-03T00:00:00.000Z" },
        },
        mapping: {
          sourceObject: "Account",
          targetObject: "account" as never,
          fields: [],
        },
      }),
    ).rejects.toBeInstanceOf(RecordSyncCursorConflictError);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      getRecordSyncCursor(pool, {
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        objectApiName: "account",
      }),
    ).resolves.toMatchObject({
      watermark: { system_modstamp: "2026-08-02T10:00:00.000Z" },
    });
  });
});
