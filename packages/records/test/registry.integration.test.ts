import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import { bumpRegistryRevision, RecordRegistry } from "../src/registry";

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
  console.warn("[records-registry] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("RecordRegistry integration", () => {
  const database = `records_registry_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  it("round-trips a typed app snapshot and invalidates across readers", async () => {
    await testPool.query(`
      insert into engine.registry_version (org_id, revision) values ('org-a', 1);
      insert into engine.record_app
        (org_id, app_id, label, purpose, status, registry_revision)
      values ('org-a', 'equipment', 'Equipment', 'Track equipment loans', 'active', 1);
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name, name_field)
      values
        ('00000000-0000-0000-0000-000000000101', 'org-a', 'equipment',
         'loan', 'Loan', 'Loans', 'equipment__loan', 'name');
      insert into engine.record_field
        (id, org_id, object_id, api_name, label, kind, column_name, required)
      values
        ('00000000-0000-0000-0000-000000000102', 'org-a',
         '00000000-0000-0000-0000-000000000101', 'name', 'Name', 'text', 'name', true);
      insert into engine.record_layout (object_id, org_id, kind, definition)
      values
        ('00000000-0000-0000-0000-000000000101', 'org-a', 'detail',
         '{"sections":[{"fields":["name"]}]}'::jsonb);
      insert into engine.app_page (org_id, app_id, api_name, label, definition)
      values ('org-a', 'equipment', 'overview', 'Overview', '{"blocks":[]}'::jsonb);
      insert into engine.record_permission
        (org_id, app_id, role, object_api_name, can_read, can_create)
      values ('org-a', 'equipment', 'member', 'loan', true, true);
    `);

    const firstReader = new RecordRegistry(testPool);
    const secondReader = new RecordRegistry(testPool);
    const initial = await firstReader.loadApp("org-a", "equipment");
    expect(initial).toMatchObject({
      revision: "1",
      app: { label: "Equipment", status: "active" },
      objects: [{ apiName: "loan", tableName: "equipment__loan" }],
      fields: [{ apiName: "name", kind: "text", required: true }],
      pages: [{ apiName: "overview" }],
      permissions: [{ role: "member", objectApiName: "loan", canRead: true }],
    });

    await expect(secondReader.loadApp("org-a", "equipment")).resolves.toMatchObject({
      revision: "1",
      app: { label: "Equipment" },
    });

    await testPool.query(
      "update engine.record_app set label = 'Equipment Loans' where org_id = 'org-a' and app_id = 'equipment'",
    );
    await expect(firstReader.loadApp("org-a", "equipment")).resolves.toMatchObject({
      app: { label: "Equipment" },
    });

    await bumpRegistryRevision(testPool, "org-a");
    await expect(firstReader.loadApp("org-a", "equipment")).resolves.toMatchObject({
      revision: "2",
      app: { label: "Equipment Loans" },
    });
    await expect(secondReader.loadApp("org-a", "equipment")).resolves.toMatchObject({
      revision: "2",
      app: { label: "Equipment Loans" },
    });
  });

  it("fails closed when persisted registry identifiers bypass the naming boundary", async () => {
    await testPool.query(
      `update engine.record_object set table_name = 'Unsafe Table'
       where org_id = 'org-a' and app_id = 'equipment'`,
    );
    await bumpRegistryRevision(testPool, "org-a");
    const reader = new RecordRegistry(testPool);
    await expect(reader.loadApp("org-a", "equipment")).rejects.toThrow(
      /record names must contain/,
    );
  });
});
