import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  RecordSavedViewPermissionError,
  RecordSavedViewStore,
} from "../src/saved-view";

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
  console.warn("[records-saved-view] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("RecordSavedViewStore integration", () => {
  const database = `records_saved_view_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;
  let store: RecordSavedViewStore;

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
    await testPool.query(`
      insert into engine.registry_version (org_id, revision) values ('org-a', 1);
      insert into engine.record_app
        (org_id, app_id, label, status, registry_revision)
      values ('org-a', 'operations', 'Operations', 'active', 1);
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name, name_field)
      values
        ('00000000-0000-0000-0000-000000000301', 'org-a', 'operations',
         'work_order', 'Work order', 'Work orders', 'operations__work_order', 'name');
      insert into engine.record_field
        (id, org_id, object_id, api_name, label, kind, column_name, required, picklist_values)
      values
        ('00000000-0000-0000-0000-000000000302', 'org-a',
         '00000000-0000-0000-0000-000000000301', 'name', 'Name', 'text', 'name', true, null),
        ('00000000-0000-0000-0000-000000000303', 'org-a',
         '00000000-0000-0000-0000-000000000301', 'status', 'Status', 'picklist', 'status', false,
         '[{"value":"open","semantic":"open"},{"value":"done","semantic":"closed"}]'::jsonb);
      insert into engine.record_permission
        (org_id, app_id, role, object_api_name, can_read)
      values
        ('org-a', 'operations', 'admin', 'work_order', true),
        ('org-a', 'operations', 'member', 'work_order', true);
    `);
    store = new RecordSavedViewStore(testPool);
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database} with (force)`);
      await adminPool.end();
    }
  });

  const privateDefinition = {
    version: 1,
    filter: { field: "status", operator: "is_open" },
    sort: { field: "name", direction: "asc" },
    search: null,
    myRecords: false,
    columns: ["name", "status"],
  } as const;

  it("isolates user views and lets admins publish org-wide views", async () => {
    const own = await store.save({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      userId: "member-a",
      role: "member",
      label: "Open work",
      shared: false,
      definition: privateDefinition,
    });
    expect(own).toMatchObject({ label: "Open work", ownerUserId: "member-a", shared: false });
    await expect(
      store.list({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "member-a",
        role: "member",
      }),
    ).resolves.toEqual([own]);
    await expect(
      store.list({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "member-b",
        role: "member",
      }),
    ).resolves.toEqual([]);

    await expect(
      store.save({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "member-a",
        role: "member",
        label: "Everyone's work",
        shared: true,
        definition: privateDefinition,
      }),
    ).rejects.toBeInstanceOf(RecordSavedViewPermissionError);

    const shared = await store.save({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      userId: "admin-a",
      role: "admin",
      label: "Everyone's work",
      shared: true,
      definition: privateDefinition,
    });
    await expect(
      store.list({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "member-b",
        role: "member",
      }),
    ).resolves.toEqual([shared]);
    await expect(
      store.remove({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "member-b",
        role: "member",
        id: shared.id,
      }),
    ).resolves.toBe(false);
    await expect(
      store.remove({
        orgId: "org-a",
        appId: "operations",
        objectApiName: "work_order",
        userId: "admin-a",
        role: "admin",
        id: shared.id,
      }),
    ).resolves.toBe(true);
  });
});
