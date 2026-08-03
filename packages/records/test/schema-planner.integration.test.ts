import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import { buildRecordsGraphjinDdl } from "../src/schema/ddl";
import {
  parseRecordAppDefinition,
  projectRecordAppDefinition,
} from "../src/schema/definition";
import {
  RecordSchemaActionPayloadError,
  RecordSchemaCounterproposalError,
  RecordsSchemaPlanner,
  type RecordSchemaPlanStore,
} from "../src/schema/planner";
import { RecordRegistry } from "../src/registry";
import type {
  RecordSchemaChange,
  RecordSchemaChangeArtifact,
} from "../src/schema/saga";

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
  console.warn("[records-schema-planner] skipping: records Postgres unavailable.");
}

describeIfLive("records schema action planner", () => {
  const database = `records_planner_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
  let adminPool: pg.Pool;
  let testPool: pg.Pool;
  const plans: Parameters<RecordSchemaPlanStore["plan"]>[0][] = [];

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

  const store: RecordSchemaPlanStore = {
    async plan(input) {
      plans.push(input);
      const artifact = {
        format: "openneko.records.schema-change.v1",
        action: input.action,
        actorUserId: input.actorUserId,
        detail: input.detail,
        document: buildRecordsGraphjinDdl(input.objects),
        objects: input.objects,
      } as RecordSchemaChangeArtifact;
      return {
        id: `change-${plans.length}`,
        orgId: input.orgId,
        appId: input.appId,
        actionRequestId: input.actionRequestId,
        desiredRevision: input.desiredRevision,
        catalogRevision: "0".repeat(64),
        artifact,
        previewSql: "CREATE TABLE ...",
        previewHash: `preview-${plans.length}`,
        phase: "planned",
        attempts: 0,
        lastError: null,
      } satisfies RecordSchemaChange;
    },
  };

  it("prepares a complete app before approval and leaves only a hidden draft stub", async () => {
    const planner = new RecordsSchemaPlanner({ pool: testPool, saga: store });
    const prepared = await planner.prepare({
      id: "request-support",
      orgId: "org-a",
      kind: "app_create",
      actorUserId: "admin-1",
      actorRole: "admin",
      payload: {
        app: "Support",
        label: "Support desk",
        objects: [
          {
            name: "Ticket",
            fields: [
              { name: "Subject", required: true },
              {
                name: "Status",
                kind: "picklist",
                picklist_values: ["New", "Closed"],
              },
            ],
          },
        ],
      },
    });

    expect(prepared.payload).toMatchObject({
      preview_hash: "preview-1",
      schema_preview: {
        action: "app_create",
        app: "support",
        objects: [{ apiName: "ticket" }],
      },
    });
    expect(plans.at(-1)).toMatchObject({
      action: "app_create",
      appId: "support",
      desiredRevision: "1",
      detail: { definition: { app: "support" } },
    });
    await expect(
      testPool.query(
        "select status from engine.record_app where org_id = 'org-a' and app_id = 'support'",
      ),
    ).resolves.toMatchObject({ rows: [{ status: "draft" }] });
    await expect(new RecordRegistry(testPool).listApps("org-a")).resolves.toEqual([]);
    await expect(
      planner.prepare({
        id: "request-support-race",
        orgId: "org-a",
        kind: "app_create",
        actorUserId: "admin-1",
        actorRole: "admin",
        payload: { app: "Support", objects: [{ name: "Ticket", fields: [{ name: "Name" }] }] },
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("derives every incremental action from the current durable registry", async () => {
    const definition = parseRecordAppDefinition({
      app: "crm",
      label: "CRM",
      objects: [
        {
          name: "Account",
          name_field: "Name",
          fields: [
            { name: "Name", required: true },
            { name: "Description", kind: "textarea" },
          ],
        },
      ],
    });
    await projectRecordAppDefinition(testPool, {
      orgId: "org-a",
      definition,
      desiredRevision: "1",
    });
    await testPool.query("create table crm__account (name text)");
    const planner = new RecordsSchemaPlanner({ pool: testPool, saga: store });
    const base = {
      orgId: "org-a",
      actorUserId: "admin-1",
      actorRole: "admin",
    } as const;

    await planner.prepare({
      ...base,
      id: "request-object",
      kind: "app_object_create",
      payload: {
        app: "crm",
        object: {
          name: "Contact",
          fields: [
            { name: "Name" },
            {
              name: "Account",
              kind: "reference",
              reference_targets: ["Account"],
            },
          ],
        },
      },
    });
    await planner.prepare({
      ...base,
      id: "request-field",
      kind: "app_field_add",
      payload: {
        app: "crm",
        object: "account",
        field: { name: "Industry", kind: "text" },
      },
    });
    await planner.prepare({
      ...base,
      id: "request-modify",
      kind: "app_field_modify",
      payload: {
        app: "crm",
        object: "account",
        field: "name",
        changes: { label: "Account name", required: false },
      },
    });
    await planner.prepare({
      ...base,
      id: "request-object-archive",
      kind: "app_object_archive",
      payload: { app: "crm", object: "account" },
    });
    await planner.prepare({
      ...base,
      id: "request-field-archive",
      kind: "app_field_archive",
      payload: { app: "crm", object: "account", field: "description" },
    });
    await planner.prepare({
      ...base,
      id: "request-permission",
      kind: "app_permission_set",
      payload: {
        app: "crm",
        role: "member",
        object: "account",
        read: true,
        create: true,
        update: false,
        delete: false,
      },
    });
    await planner.prepare({
      ...base,
      id: "request-layout",
      kind: "app_layout_update",
      payload: {
        app: "crm",
        object: "account",
        kind: "detail",
        definition: { sections: [{ fields: ["name"] }] },
      },
    });
    await planner.prepare({
      ...base,
      id: "request-page-layout",
      kind: "app_layout_update",
      payload: {
        app: "crm",
        page: "overview",
        label: "Overview",
        definition: {
          blocks: [
            {
              label: "Accounts",
              renderer: "metric",
              query: { object: "account", aggregate: "count" },
            },
          ],
        },
      },
    });

    expect(plans.slice(-8).map((plan) => plan.action)).toEqual([
      "app_object_create",
      "app_field_add",
      "app_field_modify",
      "app_object_archive",
      "app_field_archive",
      "app_permission_set",
      "app_layout_update",
      "app_layout_update",
    ]);
    const pageLayout = plans.find(
      (plan) => plan.actionRequestId === "request-page-layout",
    )!;
    expect(pageLayout.detail.definition).toMatchObject({
      pages: [
        {
          api_name: "overview",
          definition: {
            blocks: [
              {
                renderer: "metric",
                query: { object: "account", aggregate: "count" },
              },
            ],
          },
        },
      ],
    });
    const modify = plans.find((plan) => plan.actionRequestId === "request-modify")!;
    expect(
      modify.objects
        .find((object) => object.apiName === "account")
        ?.fields.find((field) => field.columnName === "name")?.required,
    ).toBe(false);
  });

  it("returns additive counter-proposals for unsafe field changes", async () => {
    const planner = new RecordsSchemaPlanner({ pool: testPool, saga: store });
    const base = {
      orgId: "org-a",
      actorUserId: "admin-1",
      actorRole: "admin",
    } as const;
    await expect(
      planner.prepare({
        ...base,
        id: "request-required",
        kind: "app_field_add",
        payload: {
          app: "crm",
          object: "account",
          field: { name: "External ID", required: true },
        },
      }),
    ).rejects.toMatchObject({
      code: "records_schema_counterproposal_required",
      counterproposal: {
        sequence: [
          expect.objectContaining({
            kind: "app_field_add",
            app: "crm",
            object: "account",
            field: expect.objectContaining({ required: false }),
          }),
          {
            kind: "record_backfill",
            app: "crm",
            object: "account",
            to: "external_id",
            requires_value: expect.objectContaining({ kind: "text" }),
          },
          {
            kind: "app_field_modify",
            app: "crm",
            object: "account",
            field: "external_id",
            changes: { required: true },
          },
        ],
      },
    });

    await expect(
      planner.prepare({
        ...base,
        id: "request-type-change",
        kind: "app_field_modify",
        payload: {
          app: "crm",
          object: "account",
          field: "description",
          changes: { kind: "integer" },
        },
      }),
    ).rejects.toMatchObject({
      code: "records_schema_counterproposal_required",
      counterproposal: {
        sequence: [
          expect.objectContaining({
            kind: "app_field_add",
            app: "crm",
            object: "account",
            field: expect.objectContaining({
              api_name: "description_v2",
              kind: "integer",
              required: false,
              read_only: false,
            }),
          }),
          {
            kind: "record_backfill",
            app: "crm",
            object: "account",
            from: "description",
            to: "description_v2",
            transform: "integer",
          },
          {
            kind: "app_field_archive",
            app: "crm",
            object: "account",
            field: "description",
          },
        ],
      },
    });
  });

  it("requires an admin snapshot before any planning side effect", async () => {
    const planner = new RecordsSchemaPlanner({ pool: testPool, saga: store });
    await expect(
      planner.prepare({
        id: "request-member",
        orgId: "org-a",
        kind: "app_create",
        actorUserId: "member-1",
        actorRole: "member",
        payload: { app: "private", objects: [{ name: "Thing", fields: [{ name: "Name" }] }] },
      }),
    ).rejects.toBeInstanceOf(RecordSchemaActionPayloadError);
    await expect(
      testPool.query(
        "select count(*)::int as count from engine.record_app where app_id = 'private'",
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
