import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  discoverRecordsMigrations,
  runRecordsMigrations,
  type RecordsMigrationResult,
} from "../../src/records-migrate";

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
  console.warn("[records-migrations] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("records migration stream", () => {
  const database = `records_migrations_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;
  let initialResult: RecordsMigrationResult;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    initialResult = await runRecordsMigrations({ pool: testPool });
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it("installs the engine registry once and records its checksum", async () => {
    expect(initialResult).toEqual({
      applied: ["0001_engine_registry.sql"],
      current: "0001_engine_registry.sql",
    });
    await expect(runRecordsMigrations({ pool: testPool })).resolves.toEqual({
      applied: [],
      current: "0001_engine_registry.sql",
    });

    const tables = await testPool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'engine' order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        "action_execution",
        "actor",
        "app_page",
        "app_schema_change",
        "app_schema_log",
        "record_app",
        "record_change_log",
        "record_field",
        "record_object",
        "record_permission",
        "registry_version",
        "schema_migrations",
      ]),
    );
    const migration = await testPool.query<{ checksum_sha256: string }>(
      "select checksum_sha256 from engine.schema_migrations where name = '0001_engine_registry.sql'",
    );
    expect(migration.rows[0]?.checksum_sha256).toMatch(/^[0-9a-f]{64}$/);

    await testPool.query(
      `update engine.schema_migrations
       set checksum_sha256 = repeat('0', 64)
       where name = '0001_engine_registry.sql'`,
    );
    await expect(runRecordsMigrations({ pool: testPool })).rejects.toThrow(
      /checksum mismatch/,
    );
    const diskMigration = (await discoverRecordsMigrations())[0];
    await testPool.query(
      `update engine.schema_migrations set checksum_sha256 = $1
       where name = '0001_engine_registry.sql'`,
      [diskMigration?.checksumSha256],
    );
  });

  it("enforces org consistency through composite foreign keys", async () => {
    await testPool.query(`
      insert into engine.record_app (org_id, app_id, label)
      values ('org-one', 'crm', 'CRM'), ('org-two', 'crm', 'CRM');
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name)
      values
        ('00000000-0000-0000-0000-000000000201', 'org-one', 'crm',
         'account', 'Account', 'Accounts', 'crm__account');
    `);
    await expect(
      testPool.query(`
        insert into engine.record_field
          (org_id, object_id, api_name, label, kind, column_name)
        values
          ('org-two', '00000000-0000-0000-0000-000000000201',
           'name', 'Name', 'text', 'name')
      `),
    ).rejects.toThrow(/foreign key/i);
  });
});
