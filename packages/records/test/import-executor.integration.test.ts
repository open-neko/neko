import pg from "pg";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  mintRecordsGraphjinToken,
  RecordsGraphjinClient,
  RecordsGraphjinRequestError,
  type RecordsGraphjinExecuteInput,
  type RecordsGraphjinTransport,
} from "../src/graphjin/client";
import { writeRecordsGraphjinConfig } from "../src/graphjin/config";
import { RecordImportExecutor } from "../src/import/executor";
import { buildRecordImportPlan } from "../src/import/plan";
import { createRecordImportRun } from "../src/import/store";
import { recordIdentifier } from "../src/naming";
import {
  loadRecordsGraphjinPolicyModel,
  projectRecordsGraphjinRoles,
} from "../src/policy/graphjin";
import { ensureRecordsAuditTrigger } from "../src/schema/audit";
import type { AppRegistrySnapshot } from "../src/types";

const graphjinImage = process.env.RECORDS_GRAPHJIN_IMAGE;
const JWT_SECRET = "import-executor-jwt-secret-that-is-at-least-thirty-two-bytes";

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

function runCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: 30_000, env: { ...process.env, GO_ENV: "development" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr) || error.message));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const reachable = await recordsDbReachable();
const describeIfLive = reachable && graphjinImage ? describe : describe.skip;

if (!reachable || !graphjinImage) {
  console.warn(
    "[records-import-executor] skipping: records Postgres or RECORDS_GRAPHJIN_IMAGE unavailable",
  );
}

class LoseFirstMutationResponse implements RecordsGraphjinTransport {
  lost = false;

  constructor(private readonly inner: RecordsGraphjinTransport) {}

  async execute<T>(input: RecordsGraphjinExecuteInput): Promise<T> {
    const result = await this.inner.execute<T>(input);
    if (!this.lost && input.operationName === "RecordsImportBatch") {
      this.lost = true;
      throw new RecordsGraphjinRequestError("simulated lost response", null);
    }
    return result;
  }
}

describeIfLive("records CSV import executor live integration", () => {
  const database = `records_import_exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const objectId = "00000000-0000-0000-0000-000000000991";
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let containerId = "";
  let graphjin: RecordsGraphjinClient;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    pool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool });
    await pool.query(`
      insert into engine.registry_version (org_id, revision) values ('org-a', 1);
      insert into engine.record_app
        (org_id, app_id, label, status, registry_revision)
      values ('org-a', 'equipment', 'Equipment', 'active', 1);
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name,
         name_field, visibility)
      values
        ('${objectId}', 'org-a', 'equipment', 'loan', 'Loan', 'Loans',
         'equipment__loan', 'name', 'org');
      insert into engine.record_field
        (id, org_id, object_id, api_name, label, kind, column_name,
         required, read_only)
      values
        ('00000000-0000-0000-0000-000000000992', 'org-a', '${objectId}',
         'name', 'Name', 'text', 'name', true, false),
        ('00000000-0000-0000-0000-000000000993', 'org-a', '${objectId}',
         'available', 'Available', 'boolean', 'available', false, false);
      insert into engine.record_permission
        (org_id, app_id, role, object_api_name,
         can_read, can_create, can_update, can_delete)
      values
        ('org-a', 'equipment', 'admin', 'loan', true, true, true, true),
        ('org-a', 'equipment', 'member', 'loan', true, true, true, true);
      insert into engine.actor (org_id, user_id, role)
      values ('org-a', 'records-service', 'service');
      create table public.equipment__loan (
        id text primary key,
        org_id text not null,
        name text not null,
        available boolean,
        nk_created_at timestamptz not null default now(),
        nk_created_by text not null,
        nk_updated_at timestamptz not null default now(),
        nk_updated_by text not null,
        nk_action_request_id text not null,
        nk_mutation_id text not null,
        nk_deleted_at timestamptz
      );
      insert into public.equipment__loan
        (id, org_id, name, available, nk_created_by, nk_updated_by,
         nk_action_request_id, nk_mutation_id)
      values ('loan-existing', 'org-a', 'Existing', true, 'seed', 'seed',
              'seed-request', 'seed-mutation');
    `);
    await ensureRecordsAuditTrigger(pool, {
      tableSchema: recordIdentifier("public"),
      tableName: recordIdentifier("equipment__loan"),
      appId: "equipment",
      objectApiName: recordIdentifier("loan"),
    });

    const directory = await mkdtemp(join(tmpdir(), "records-import-config-"));
    const poolConfig = buildRecordsPoolConfig(process.env, { database });
    const connection = new URL("postgres://localhost/records");
    connection.hostname = process.env.RECORDS_GRAPHJIN_DB_HOST ?? "host.internal";
    connection.port = String(poolConfig.port);
    connection.username = String(poolConfig.user);
    connection.password = String(poolConfig.password ?? "");
    connection.pathname = `/${database}`;
    connection.searchParams.set("sslmode", "disable");
    await writeRecordsGraphjinConfig({
      configFile: join(directory, "dev.yml"),
      config: {
        orgId: "org-a",
        roles: projectRecordsGraphjinRoles(
          await loadRecordsGraphjinPolicyModel(pool, "org-a"),
        ),
        database: { connectionString: connection.toString() },
        jwt: { secret: JWT_SECRET },
        secretKey: "import-cursor-secret-that-is-at-least-thirty-two-bytes",
      },
      validate: async ({ configDirectory }) => {
        await runCommand("docker", [
          "run",
          "--rm",
          "--entrypoint",
          "graphjin",
          "--volume",
          `${configDirectory}:/config:ro`,
          graphjinImage!,
          "serve",
          "test",
          "--json",
          "--path",
          "/config",
        ]);
      },
      reloadRecordsGraphjin: async () => {},
    });
    const started = await runCommand("docker", [
      "run",
      "--detach",
      "--rm",
      "--entrypoint",
      "graphjin",
      "--publish",
      "127.0.0.1::8090",
      "--volume",
      `${directory}:/config:ro`,
      graphjinImage!,
      "serve",
      "--path",
      "/config",
    ]);
    containerId = started.stdout.trim();
    const portOutput = await runCommand("docker", ["port", containerId, "8090/tcp"]);
    const port = Number.parseInt(portOutput.stdout.trim().split(":").at(-1) ?? "", 10);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
      } catch {
        // Still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    graphjin = new RecordsGraphjinClient({ baseUrl: `http://127.0.0.1:${port}` });
  }, 30_000);

  afterAll(async () => {
    if (containerId) await runCommand("docker", ["stop", containerId]).catch(() => undefined);
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it("bulk inserts, quarantines rejects, and recovers a lost commit response", async () => {
    const bytes = Buffer.from(
      [
        "id,name,available",
        "loan-1,Laptop,true",
        "loan-2,Monitor,false",
        "loan-2,Duplicate,true",
        "loan-existing,Already here,true",
        "loan-3,,true",
        "loan-4,Dock,not-a-boolean",
      ].join("\n"),
    );
    const registry = new (await import("../src/registry")).RecordRegistry(pool);
    const loaded = await registry.loadApp("org-a", "equipment");
    expect(loaded).not.toBeNull();
    const plan = buildRecordImportPlan({
      snapshot: loaded as AppRegistrySnapshot,
      objectApiName: "loan",
      sourcePath: "imports/run-1/loans.csv",
      sourceName: "loans.csv",
      bytes,
      batchSize: 3,
    });
    const run = await createRecordImportRun(pool, {
      id: "00000000-0000-4000-a000-000000000994",
      orgId: "org-a",
      actionRequestId: "import-executor-action",
      plan,
    });
    const lossyTransport = new LoseFirstMutationResponse(graphjin);
    const executor = new RecordImportExecutor({
      pool,
      graphjin: lossyTransport,
      serviceToken: () =>
        mintRecordsGraphjinToken({
          secret: JWT_SECRET,
          orgId: "org-a",
          userId: "records-service",
          role: "service",
        }),
      leaseOwner: "import-test-worker",
      readSource: async () => bytes,
    });

    const report = await executor.execute({
      orgId: "org-a",
      importRunId: run.id,
      actorUserId: "admin-1",
    });
    expect(lossyTransport.lost).toBe(true);
    expect(report).toEqual({
      status: "succeeded",
      importRunId: run.id,
      appId: "equipment",
      objectApiName: "loan",
      sourceName: "loans.csv",
      sourceRows: 6,
      inserted: 2,
      rejected: 4,
      duplicates: 2,
      batches: 2,
      reconciled: true,
    });
    const rows = await pool.query<{ id: string }>(
      "select id from public.equipment__loan order by id",
    );
    expect(rows.rows.map((row) => row.id)).toEqual([
      "loan-1",
      "loan-2",
      "loan-existing",
    ]);
    const audit = await pool.query<{ action: string }>(
      `select action from engine.record_change_log
       where action_request_id = 'import-executor-action' order by record_id`,
    );
    expect(audit.rows).toEqual([{ action: "import" }, { action: "import" }]);
    const rejectCodes = await pool.query<{ reason_code: string }>(
      `select reason_code from engine.import_reject
       where import_run_id = $1 order by row_number`,
      [run.id],
    );
    expect(rejectCodes.rows.map((row) => row.reason_code)).toEqual([
      "duplicate",
      "duplicate",
      "validation",
      "validation",
    ]);

    await expect(
      executor.execute({
        orgId: "org-a",
        importRunId: run.id,
        actorUserId: "admin-1",
      }),
    ).resolves.toEqual(report);
  }, 30_000);
});

