import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  claimRecordsActionExecution,
  failRecordsActionExecution,
  getRecordsActionExecution,
  RecordsActionLeaseBusyError,
  RecordsActionLeaseLostError,
  RecordsActionTerminalError,
  renewRecordsActionExecutionLease,
  succeedRecordsActionExecution,
} from "../src/actions/execution";

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
const describeIfRecordsDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[records-action-execution] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("records action execution receipts", () => {
  const database = `records_actions_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
    await testPool.query(`
      insert into engine.record_app (org_id, app_id, label, status)
      values ('org-a', 'equipment', 'Equipment', 'active')
    `);
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database}`);
      await adminPool.end();
    }
  });

  const claimInput = {
    actionRequestId: "request-1",
    orgId: "org-a",
    appId: "equipment",
    actionKind: "record_create",
    leaseMs: 5_000,
  } as const;

  it("allows exactly one concurrent claimant and reclaims only after expiry", async () => {
    const results = await Promise.allSettled([
      claimRecordsActionExecution(testPool, { ...claimInput, leaseOwner: "worker-a" }),
      claimRecordsActionExecution(testPool, { ...claimInput, leaseOwner: "worker-b" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RecordsActionLeaseBusyError,
    );

    const winner = fulfilled[0];
    if (!winner || winner.status !== "fulfilled") throw new Error("missing action claim winner");
    const owner = winner.value.execution.leaseOwner!;
    await expect(
      renewRecordsActionExecutionLease(testPool, {
        actionRequestId: claimInput.actionRequestId,
        leaseOwner: owner,
      }),
    ).resolves.toMatchObject({ status: "running", leaseOwner: owner });

    await testPool.query(
      "update engine.action_execution set lease_expires_at = now() - interval '1 second' where action_request_id = $1",
      [claimInput.actionRequestId],
    );
    await expect(
      renewRecordsActionExecutionLease(testPool, {
        actionRequestId: claimInput.actionRequestId,
        leaseOwner: owner,
      }),
    ).rejects.toBeInstanceOf(RecordsActionLeaseLostError);
    await expect(
      claimRecordsActionExecution(testPool, { ...claimInput, leaseOwner: "worker-c" }),
    ).resolves.toMatchObject({
      kind: "claimed",
      execution: { status: "running", leaseOwner: "worker-c" },
    });
  });

  it("stores a serializable outcome and returns it on replay", async () => {
    const completed = await succeedRecordsActionExecution(testPool, {
      actionRequestId: claimInput.actionRequestId,
      leaseOwner: "worker-c",
      result: { id: "loan-1", operation: "create" },
    });
    expect(completed).toMatchObject({ status: "succeeded", leaseOwner: null });
    await expect(
      claimRecordsActionExecution(testPool, { ...claimInput, leaseOwner: "worker-d" }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "replay",
        result: { id: "loan-1", operation: "create" },
      }),
    );
    await expect(
      getRecordsActionExecution(testPool, claimInput.actionRequestId),
    ).resolves.toMatchObject({
      finishedAt: expect.any(Date),
      result: { id: "loan-1" },
    });
  });

  it("lets the same durable job identity resume an unexpired lease", async () => {
    const input = {
      ...claimInput,
      actionRequestId: "request-same-job-resume",
      actionKind: "records_import_start",
      leaseOwner: "records-import-job:job-42",
      leaseMs: 60_000,
    };
    const first = await claimRecordsActionExecution(testPool, input);
    expect(first.kind).toBe("claimed");
    const firstExpiry = first.execution.leaseExpiresAt?.getTime() ?? 0;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = await claimRecordsActionExecution(testPool, input);

    expect(resumed.kind).toBe("claimed");
    expect(resumed.execution.leaseOwner).toBe(input.leaseOwner);
    expect(resumed.execution.leaseExpiresAt?.getTime() ?? 0).toBeGreaterThan(
      firstExpiry,
    );
  });

  it("rejects request-id identity reuse and terminal failure replays", async () => {
    await expect(
      claimRecordsActionExecution(testPool, {
        ...claimInput,
        appId: null,
        leaseOwner: "worker-x",
      }),
    ).rejects.toThrow(/different identity/);

    const failedInput = { ...claimInput, actionRequestId: "request-failed" };
    await claimRecordsActionExecution(testPool, {
      ...failedInput,
      leaseOwner: "worker-a",
    });
    await failRecordsActionExecution(testPool, {
      actionRequestId: failedInput.actionRequestId,
      leaseOwner: "worker-a",
      error: { code: "validation_failed", message: "bad input" },
    });
    await expect(
      claimRecordsActionExecution(testPool, {
        ...failedInput,
        leaseOwner: "worker-b",
      }),
    ).rejects.toBeInstanceOf(RecordsActionTerminalError);
  });
});
