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
} from "../src/graphjin/client";
import { writeRecordsGraphjinConfig } from "../src/graphjin/config";
import {
  loadRecordsGraphjinPolicyModel,
  projectRecordsGraphjinRoles,
} from "../src/policy/graphjin";
import { ensureRecordsAuditTrigger } from "../src/schema/audit";
import {
  RecordConcurrencyConflictError,
  RecordNotFoundOrDeniedError,
  RecordWriteExecutor,
} from "../src/write/executor";
import { RecordOwnerBackfillExecutor } from "../src/identity/backfill";
import { RecordValidationError } from "../src/write/validate";
import { validateRecordIdentifier } from "../src/naming";

const graphjinImage = process.env.RECORDS_GRAPHJIN_IMAGE;
const JWT_SECRET = "write-executor-jwt-secret-that-is-at-least-thirty-two-bytes";

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
    "[records-write-executor] skipping: records Postgres or RECORDS_GRAPHJIN_IMAGE unavailable.",
  );
}

describeIfLive("records write executor live integration", () => {
  const database = `records_write_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
    await testPool.query(`
      insert into engine.registry_version (org_id, revision) values ('org-a', 1);
      insert into engine.record_app
        (org_id, app_id, label, status, registry_revision)
      values ('org-a', 'equipment', 'Equipment', 'active', 1);
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name,
         name_field, visibility)
      values
        ('00000000-0000-0000-0000-000000000701', 'org-a', 'equipment',
         'loan', 'Loan', 'Loans', 'equipment__loan', 'name', 'owner');
      insert into engine.record_field
        (id, org_id, object_id, api_name, source_api_name, label, kind, column_name,
         required, read_only, picklist_values)
      values
        ('00000000-0000-0000-0000-000000000702', 'org-a',
         '00000000-0000-0000-0000-000000000701', 'name', null, 'Name', 'text',
         'name', true, false, null),
        ('00000000-0000-0000-0000-000000000703', 'org-a',
         '00000000-0000-0000-0000-000000000701', 'status', null, 'Status',
         'picklist', 'status', true, false, '["new","active"]'::jsonb),
        ('00000000-0000-0000-0000-000000000704', 'org-a',
         '00000000-0000-0000-0000-000000000701', 'legacy_code', null, 'Legacy code',
         'text', 'legacy_code', false, true, null),
        ('00000000-0000-0000-0000-000000000705', 'org-a',
         '00000000-0000-0000-0000-000000000701', 'owner_id', 'OwnerId', 'Source owner',
         'text', 'owner_id', true, false, null);
      insert into engine.record_permission
        (org_id, app_id, role, object_api_name,
         can_read, can_create, can_update, can_delete)
      values
        ('org-a', 'equipment', 'member', 'loan', true, true, true, true),
        ('org-a', 'equipment', 'admin', 'loan', true, true, true, true);
      insert into engine.actor (org_id, user_id, role)
      values ('org-a', 'records-service', 'service');
      insert into engine.identity_map
        (org_id, source_instance_id, app_id, source_user_id, source_email,
         source_name, source_is_active, app_user_id, status, linked_at)
      values
        ('org-a', 'sf-prod', 'equipment', '005-alice', 'alice@example.com',
         'Alice', true, 'user-alice', 'linked', now());

      create table public.equipment__loan (
        id text primary key,
        org_id text not null,
        owner_user_id text not null,
        name text not null,
        status text not null,
        legacy_code text,
        owner_id text not null,
        nk_created_at timestamptz not null,
        nk_created_by text not null,
        nk_updated_at timestamptz not null,
        nk_updated_by text not null,
        nk_action_request_id text not null,
        nk_mutation_id text not null,
        nk_deleted_at timestamptz
      );
    `);
    await ensureRecordsAuditTrigger(testPool, {
      tableSchema: validateRecordIdentifier("public"),
      tableName: validateRecordIdentifier("equipment__loan"),
      appId: "equipment",
      objectApiName: validateRecordIdentifier("loan"),
    });
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it(
    "validates, authorizes, mutates, audits, replays, deletes, and restores",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "records-write-config-"));
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
            await loadRecordsGraphjinPolicyModel(testPool, "org-a"),
          ),
          database: { connectionString: connection.toString() },
          jwt: { secret: JWT_SECRET },
          secretKey: "write-cursor-secret-that-is-at-least-thirty-two-bytes",
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
      const containerId = started.stdout.trim();
      try {
        const portOutput = await runCommand("docker", ["port", containerId, "8090/tcp"]);
        const port = Number.parseInt(portOutput.stdout.trim().split(":").at(-1) ?? "", 10);
        let healthy = false;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
              healthy = true;
              break;
            }
          } catch {
            // Container is still starting.
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!healthy) throw new Error("records GraphJin did not become healthy");

        const sourceWrites: Array<{ actionRequestId: string; recordId: string }> = [];
        const graphjin = new RecordsGraphjinClient({
          baseUrl: `http://127.0.0.1:${port}`,
        });
        const serviceToken = () =>
          mintRecordsGraphjinToken({
            secret: JWT_SECRET,
            orgId: "org-a",
            userId: "records-service",
            role: "service",
          });
        const executor = new RecordWriteExecutor({
          pool: testPool,
          graphjin,
          serviceToken,
          leaseOwner: "test-worker",
          recordSourceWrite: async (write) => {
            sourceWrites.push({
              actionRequestId: write.actionRequestId,
              recordId: write.recordId,
            });
          },
          now: () => new Date("2026-08-02T12:00:00.000Z"),
        });
        const member = { userId: "member-1", role: "member" as const };
        const admin = { userId: "admin-1", role: "admin" as const };

        const created = await executor.execute({
          actionRequestId: "request-create-loan",
          orgId: "org-a",
          appId: "equipment",
          objectApiName: "loan",
          operation: "create",
          actor: member,
          fields: {
            id: "loan-1",
            name: "Laptop",
            status: "new",
            owner_id: "005-alice",
          },
        });
        expect(created).toMatchObject({
          id: "loan-1",
          operation: "create",
          replayed: false,
          recovered: false,
        });
        await expect(
          executor.execute({
            actionRequestId: "request-create-loan",
            orgId: "org-a",
            appId: "equipment",
            objectApiName: "loan",
            operation: "create",
            actor: member,
            fields: {
              id: "loan-1",
              name: "Laptop",
              status: "new",
              owner_id: "005-alice",
            },
          }),
        ).resolves.toMatchObject({ id: "loan-1", replayed: true });

        await executor.execute({
          actionRequestId: "request-create-other",
          orgId: "org-a",
          appId: "equipment",
          objectApiName: "loan",
          operation: "create",
          actor: admin,
          fields: {
            id: "loan-2",
            name: "Other Laptop",
            status: "new",
            owner_id: "005-alice",
            owner_user_id: "member-2",
          },
        });
        await expect(
          executor.execute({
            actionRequestId: "request-update-other",
            orgId: "org-a",
            appId: "equipment",
            objectApiName: "loan",
            operation: "update",
            actor: member,
            id: "loan-2",
            fields: { status: "active" },
          }),
        ).rejects.toBeInstanceOf(RecordNotFoundOrDeniedError);

        const readLoan = () =>
          graphjin.execute<{ rows: Array<{ id: string; status: string }> }>({
            operationName: "RecordsWriteReadAfterMutation",
            query:
              "query RecordsWriteReadAfterMutation { rows: equipment__loan(where: { id: { eq: $id } }, limit: 1) { id status } }",
            variables: { id: "loan-1" },
            token: serviceToken(),
          });
        await expect(readLoan()).resolves.toMatchObject({
          rows: [{ id: "loan-1", status: "new" }],
        });

        await executor.execute({
          actionRequestId: "request-update-loan",
          orgId: "org-a",
          appId: "equipment",
          objectApiName: "loan",
          operation: "update",
          actor: member,
          id: "loan-1",
          fields: { status: "active" },
          expected: { status: "new" },
        });
        // GraphJin returns an empty mutation selection when the updated value
        // was part of the where predicate. Its default response cache cannot
        // infer which row to invalidate in that case, so records configs keep
        // response caching disabled and the same named read must be fresh.
        await expect(readLoan()).resolves.toMatchObject({
          rows: [{ id: "loan-1", status: "active" }],
        });
        await expect(
          executor.execute({
            actionRequestId: "request-update-stale",
            orgId: "org-a",
            appId: "equipment",
            objectApiName: "loan",
            operation: "update",
            actor: member,
            id: "loan-1",
            fields: { name: "Stale Rename" },
            expected: { status: "new" },
          }),
        ).rejects.toBeInstanceOf(RecordConcurrencyConflictError);
        await expect(
          executor.execute({
            actionRequestId: "request-readonly",
            orgId: "org-a",
            appId: "equipment",
            objectApiName: "loan",
            operation: "update",
            actor: member,
            id: "loan-1",
            fields: { legacy_code: "forbidden" },
          }),
        ).rejects.toBeInstanceOf(RecordValidationError);

        await executor.execute({
          actionRequestId: "request-delete-loan",
          orgId: "org-a",
          appId: "equipment",
          objectApiName: "loan",
          operation: "delete",
          actor: member,
          id: "loan-1",
        });
        await executor.execute({
          actionRequestId: "request-restore-loan",
          orgId: "org-a",
          appId: "equipment",
          objectApiName: "loan",
          operation: "restore",
          actor: member,
          id: "loan-1",
        });

        const rows = await testPool.query<{
          id: string;
          org_id: string;
          owner_user_id: string;
          status: string;
          nk_deleted_at: Date | null;
        }>(`
          select id, org_id, owner_user_id, status, nk_deleted_at
          from public.equipment__loan order by id
        `);
        expect(rows.rows).toEqual([
          {
            id: "loan-1",
            org_id: "org-a",
            owner_user_id: "member-1",
            status: "active",
            nk_deleted_at: null,
          },
          {
            id: "loan-2",
            org_id: "org-a",
            owner_user_id: "member-2",
            status: "new",
            nk_deleted_at: null,
          },
        ]);
        const history = await testPool.query<{ action: string }>(
          `select action from engine.record_change_log
           where record_id = 'loan-1' order by id`,
        );
        expect(history.rows.map((row) => row.action)).toEqual([
          "create",
          "update",
          "delete",
          "restore",
        ]);
        expect(sourceWrites.map((write) => write.actionRequestId)).toEqual([
          "request-create-loan",
          "request-create-other",
          "request-update-loan",
          "request-delete-loan",
          "request-restore-loan",
        ]);
        const succeeded = await testPool.query<{ count: string }>(
          "select count(*) from engine.action_execution where status = 'succeeded'",
        );
        expect(succeeded.rows).toEqual([{ count: "5" }]);

        const ownerBackfill = new RecordOwnerBackfillExecutor({
          pool: testPool,
          graphjin,
          serviceToken,
          leaseOwner: "identity-worker",
        });
        await expect(
          ownerBackfill.execute({
            actionRequestId: "request-owner-backfill",
            orgId: "org-a",
            appId: "equipment",
            sourceInstanceId: "sf-prod",
            actorUserId: "admin-1",
          }),
        ).resolves.toMatchObject({ scanned: 2, updated: 2, unchanged: 0 });
        await expect(
          ownerBackfill.execute({
            actionRequestId: "request-owner-backfill",
            orgId: "org-a",
            appId: "equipment",
            sourceInstanceId: "sf-prod",
            actorUserId: "admin-1",
          }),
        ).resolves.toMatchObject({ updated: 2, replayed: true });
        const ownership = await testPool.query<{
          id: string;
          owner_user_id: string;
        }>(
          `select id, owner_user_id from public.equipment__loan order by id`,
        );
        expect(ownership.rows).toEqual([
          { id: "loan-1", owner_user_id: "user-alice" },
          { id: "loan-2", owner_user_id: "user-alice" },
        ]);
        const ownershipAudit = await testPool.query<{
          record_id: string;
          action: string;
        }>(
          `select record_id, action from engine.record_change_log
           where action_request_id = 'request-owner-backfill' order by record_id`,
        );
        expect(ownershipAudit.rows).toEqual([
          { record_id: "loan-1", action: "sync" },
          { record_id: "loan-2", action: "sync" },
        ]);
      } finally {
        await runCommand("docker", ["rm", "--force", containerId]).catch(() => undefined);
      }
    },
    45_000,
  );
});
