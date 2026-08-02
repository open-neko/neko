import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import { RecordRegistry } from "../src/registry";
import {
  parseRecordAppDefinition,
  projectRecordAppDefinition,
} from "../src/schema/definition";

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
const describeIfLive = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[records-schema-definition] skipping: records Postgres unavailable.");
}

describeIfLive("records app definition projection", () => {
  const database = `records_definition_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
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
      await adminPool.query(`drop database if exists ${database}`);
      await adminPool.end();
    }
  });

  it("idempotently projects apps, objects, fields, permissions, and layouts", async () => {
    const definition = parseRecordAppDefinition({
      app: "support",
      label: "Support",
      objects: [
        {
          name: "ticket",
          label: "Ticket",
          visibility: "owner",
          fields: [
            { name: "subject", label: "Subject", required: true },
            {
              name: "status",
              label: "Status",
              kind: "picklist",
              picklist_values: ["new", "closed"],
            },
            {
              name: "requester",
              kind: "reference",
              reference_targets: ["requester"],
            },
          ],
          layouts: [
            {
              kind: "detail",
              definition: { sections: [{ fields: ["subject", "status"] }] },
            },
          ],
        },
        {
          name: "requester",
          fields: [{ name: "name" }],
        },
      ],
      permissions: [
        {
          role: "admin",
          object: "ticket",
          read: true,
          create: true,
          update: true,
          delete: true,
        },
        {
          role: "member",
          object: "ticket",
          read: true,
          create: true,
          update: true,
          delete: false,
        },
      ],
      pages: [
        {
          name: "overview",
          label: "Overview",
          definition: { blocks: [] },
          nav_order: 1,
        },
      ],
    });

    await expect(
      projectRecordAppDefinition(testPool, {
        orgId: "org-a",
        definition,
        desiredRevision: "1",
      }),
    ).resolves.toBe("1");
    definition.label = "Customer Support";
    await expect(
      projectRecordAppDefinition(testPool, {
        orgId: "org-a",
        definition,
        desiredRevision: "2",
      }),
    ).resolves.toBe("2");
    await expect(
      projectRecordAppDefinition(testPool, {
        orgId: "org-a",
        definition,
        desiredRevision: "2",
      }),
    ).resolves.toBe("2");
    await expect(
      testPool.query(
        "select revision::text as revision from engine.registry_version where org_id = 'org-a'",
      ),
    ).resolves.toMatchObject({ rows: [{ revision: "2" }] });

    const snapshot = await new RecordRegistry(testPool).loadApp("org-a", "support");
    expect(snapshot).toMatchObject({
      revision: "2",
      app: { label: "Customer Support", status: "active", registryRevision: "2" },
      pages: [{ apiName: "overview", navOrder: 1 }],
    });
    expect(snapshot?.objects.map((object) => object.apiName).sort()).toEqual([
      "requester",
      "ticket",
    ]);
    expect(snapshot?.objects.find((object) => object.apiName === "ticket")).toMatchObject({
      visibility: "owner",
    });
    expect(snapshot?.fields.map((field) => field.apiName).sort()).toEqual([
      "name",
      "requester",
      "status",
      "subject",
    ]);
    expect(snapshot?.permissions).toHaveLength(2);
    expect(snapshot?.layouts).toEqual([
      expect.objectContaining({ kind: "detail" }),
    ]);
    await expect(
      testPool.query(
        "select role from engine.actor where org_id = 'org-a' and user_id = 'records-service'",
      ),
    ).resolves.toMatchObject({ rows: [{ role: "service" }] });
    await expect(
      testPool.query(
        `select source.api_name as source, target.api_name as target
         from engine.record_relationship relationship
         join engine.record_object source on source.id = relationship.from_object
         join engine.record_object target on target.id = relationship.to_object`,
      ),
    ).resolves.toMatchObject({
      rows: [{ source: "ticket", target: "requester" }],
    });
  });
});
