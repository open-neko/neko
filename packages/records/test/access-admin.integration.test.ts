import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import { loadEffectiveRecordAccess } from "../src/policy/access";
import {
  RecordAccessAdminError,
  RecordsAccessAdmin,
} from "../src/policy/admin";

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
  console.warn("[records-access-admin] skipping: records Postgres unreachable.");
}

describeIfRecordsDb("records subject entitlement administration", () => {
  const database = `records_access_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;
  let accessAdmin: RecordsAccessAdmin;
  const actor = { userId: "admin-1", actionRequestId: "request-1" };

  beforeAll(async () => {
    adminPool = new pg.Pool(buildRecordsPoolConfig());
    await adminPool.query(`create database ${database}`);
    testPool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
    await runRecordsMigrations({ pool: testPool });
    accessAdmin = new RecordsAccessAdmin(testPool);
    await testPool.query(`
      insert into engine.record_app (org_id, app_id, label)
      values ('org-a', 'crm', 'CRM'), ('org-b', 'crm', 'CRM');
      insert into engine.record_object
        (id, org_id, app_id, api_name, label, plural_label, table_name)
      values
        ('00000000-0000-0000-0000-000000000401', 'org-a', 'crm',
         'activity', 'Activity', 'Activities', 'crm__activity'),
        ('00000000-0000-0000-0000-000000000403', 'org-b', 'crm',
         'activity', 'Activity', 'Activities', 'crm_b__activity');
      insert into engine.record_field
        (id, org_id, object_id, api_name, label, kind, column_name)
      values
        ('00000000-0000-0000-0000-000000000402', 'org-a',
         '00000000-0000-0000-0000-000000000401',
         'subject', 'Subject', 'text', 'subject');
    `);
  });

  afterAll(async () => {
    if (testPool) await testPool.end();
    if (adminPool) {
      await adminPool.query(`drop database if exists ${database}`);
      await adminPool.end();
    }
  });

  it("fails closed and enforces the app/object/field hierarchy", async () => {
    const target = { type: "user" as const, id: "user-1" };
    await expect(
      accessAdmin.setObject({
        orgId: "org-a",
        appId: "crm",
        objectApiName: "activity",
        subject: target,
        permissions: {
          canRead: true,
          canCreate: false,
          canUpdate: false,
          canDelete: false,
        },
        actor,
      }),
    ).rejects.toBeInstanceOf(RecordAccessAdminError);
    await expect(
      accessAdmin.setObject({
        orgId: "org-a",
        appId: "crm",
        objectApiName: "activity",
        subject: target,
        permissions: {
          canRead: false,
          canCreate: true,
          canUpdate: false,
          canDelete: false,
        },
        actor,
      }),
    ).rejects.toThrow(/require read access/);
    await expect(
      loadEffectiveRecordAccess(testPool, {
        orgId: "org-a",
        appId: "crm",
        actor: { userId: "user-1", role: "member" },
      }),
    ).resolves.toEqual({ app: false, objects: [], fields: [] });
  });

  it("unions direct and current-group grants, then revokes them immediately", async () => {
    const user = { type: "user" as const, id: "user-1" };
    const group = { type: "group" as const, id: "group-sales" };
    for (const subject of [user, group]) {
      await accessAdmin.grantApp({
        orgId: "org-a",
        appId: "crm",
        subject,
        actor,
      });
    }
    await accessAdmin.setObject({
      orgId: "org-a",
      appId: "crm",
      objectApiName: "activity",
      subject: group,
      permissions: {
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      },
      actor,
    });
    await accessAdmin.setField({
      orgId: "org-a",
      appId: "crm",
      objectApiName: "activity",
      fieldApiName: "subject",
      subject: group,
      permissions: { canRead: true, canWrite: false },
      actor,
    });
    await accessAdmin.setObject({
      orgId: "org-a",
      appId: "crm",
      objectApiName: "activity",
      subject: user,
      permissions: {
        canRead: true,
        canCreate: true,
        canUpdate: false,
        canDelete: false,
      },
      actor,
    });
    await accessAdmin.setField({
      orgId: "org-a",
      appId: "crm",
      objectApiName: "activity",
      fieldApiName: "subject",
      subject: user,
      permissions: { canRead: true, canWrite: true },
      actor,
    });

    await expect(
      loadEffectiveRecordAccess(testPool, {
        orgId: "org-a",
        appId: "crm",
        actor: {
          userId: "user-1",
          role: "member",
          groupIds: ["group-sales"],
        },
      }),
    ).resolves.toMatchObject({
      app: true,
      objects: [{ objectApiName: "activity", canRead: true, canCreate: true }],
      fields: [{ fieldId: "00000000-0000-0000-0000-000000000402", canWrite: true }],
    });

    await accessAdmin.revokeApp({
      orgId: "org-a",
      appId: "crm",
      subject: user,
      actor,
    });
    const groupOnly = await loadEffectiveRecordAccess(testPool, {
      orgId: "org-a",
      appId: "crm",
      actor: {
        userId: "user-1",
        role: "member",
        groupIds: ["group-sales"],
      },
    });
    expect(groupOnly.objects[0]).toMatchObject({
      canRead: true,
      canCreate: false,
    });
    expect(groupOnly.fields[0]).toMatchObject({ canRead: true, canWrite: false });

    await accessAdmin.revokeApp({
      orgId: "org-a",
      appId: "crm",
      subject: group,
      actor,
    });
    await expect(
      loadEffectiveRecordAccess(testPool, {
        orgId: "org-a",
        appId: "crm",
        actor: {
          userId: "user-1",
          role: "member",
          groupIds: ["group-sales"],
        },
      }),
    ).resolves.toEqual({ app: false, objects: [], fields: [] });

    await expect(
      loadEffectiveRecordAccess(testPool, {
        orgId: "org-b",
        appId: "crm",
        actor: {
          userId: "user-1",
          role: "member",
          groupIds: ["group-sales"],
        },
      }),
    ).resolves.toEqual({ app: false, objects: [], fields: [] });
    const audits = await testPool.query<{ count: string }>(
      `select count(*)::text as count from engine.entitlement_audit
       where org_id = 'org-a' and actor_user_id = 'admin-1'`,
    );
    expect(Number(audits.rows[0]?.count ?? "0")).toBeGreaterThanOrEqual(8);
  });
});
