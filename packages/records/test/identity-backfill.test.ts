import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  RecordOwnerBackfillAuditError,
  RecordOwnerBackfillExecutor,
} from "../src/identity/backfill";
import { recordIdentifier } from "../src/naming";
import type { AppRegistrySnapshot } from "../src/types";

const now = new Date("2026-08-02T12:00:00.000Z");

function snapshot(input: { sourceInstanceField?: boolean } = {}): AppRegistrySnapshot {
  const objectId = "00000000-0000-0000-0000-000000000991";
  return {
    revision: "1",
    app: {
      orgId: "org-a",
      appId: "crm",
      label: "CRM",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "1",
    },
    objects: [
      {
        id: objectId,
        orgId: "org-a",
        appId: "crm",
        apiName: recordIdentifier("account"),
        sourceApiName: "Account",
        label: "Account",
        pluralLabel: "Accounts",
        tableSchema: recordIdentifier("public"),
        tableName: recordIdentifier("crm__account"),
        nameField: recordIdentifier("name"),
        visibility: "owner",
        custom: false,
        archivedAt: null,
        recordCount: null,
      },
    ],
    fields: [
      {
        id: "00000000-0000-0000-0000-000000000992",
        orgId: "org-a",
        objectId,
        apiName: recordIdentifier("owner_id"),
        sourceApiName: "OwnerId",
        label: "Owner",
        kind: "reference",
        columnName: recordIdentifier("owner_id"),
        required: false,
        readOnly: true,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: [recordIdentifier("user")],
        length: null,
        scale: null,
      },
      ...(input.sourceInstanceField
        ? [
            {
              id: "00000000-0000-0000-0000-000000000993",
              orgId: "org-a",
              objectId,
              apiName: recordIdentifier("source_instance_id"),
              sourceApiName: "OpenNekoSourceInstanceId",
              label: "Source instance",
              kind: "text" as const,
              columnName: recordIdentifier("source_instance_id"),
              required: true,
              readOnly: true,
              archivedAt: null,
              picklistValues: null,
              referenceTargets: null,
              length: null,
              scale: null,
            },
          ]
        : []),
    ],
    layouts: [],
    pages: [],
    permissions: [],
  };
}

function rawAction(status = "running", result: Record<string, unknown> | null = null) {
  return {
    action_request_id: "request-1",
    org_id: "org-a",
    app_id: "crm",
    action_kind: "record_sync",
    status,
    lease_owner: status === "running" ? "worker-1" : null,
    lease_expires_at: status === "running" ? new Date(now.getTime() + 60_000) : null,
    result,
    error: null,
    started_at: now,
    finished_at: status === "succeeded" ? now : null,
  };
}

function rawIdentity(sourceInstanceId = "sf-prod") {
  return {
    org_id: "org-a",
    source_instance_id: sourceInstanceId,
    app_id: "crm",
    source_user_id: "005-alice",
    source_email: "alice@example.com",
    source_name: "Alice",
    source_is_active: true,
    app_user_id: "user-alice",
    status: "linked",
    linked_at: now,
    updated_at: now,
  };
}

function harness(input: { identities?: ReturnType<typeof rawIdentity>[]; writeAudits?: boolean } = {}) {
  const identities = input.identities ?? [rawIdentity()];
  const audits = new Set<string>();
  let succeeded = false;
  const query = vi.fn(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes("from engine.identity_map")) {
      return { rows: identities, rowCount: identities.length };
    }
    if (sql.includes("set lease_expires_at")) {
      return { rows: [rawAction()], rowCount: 1 };
    }
    if (sql.includes("select mutation_id from engine.record_change_log")) {
      const requested = values[1] as string[];
      const rows = requested.filter((id) => audits.has(id)).map((id) => ({ mutation_id: id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("count(*)::text as updated")) {
      return { rows: [{ updated: String(audits.size) }], rowCount: 1 };
    }
    if (sql.includes("set status = 'succeeded'")) {
      succeeded = true;
      return {
        rows: [rawAction("succeeded", JSON.parse(String(values[2])))],
        rowCount: 1,
      };
    }
    throw new Error(`unexpected pool query: ${sql}`);
  });
  const clientQuery = vi.fn(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("insert into engine.action_execution")) {
      return { rows: [rawAction()], rowCount: 1 };
    }
    throw new Error(`unexpected client query: ${sql}`);
  });
  const pool = {
    query,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  } as unknown as Pool;
  const execute = vi.fn(async (request: { query: string; variables?: Record<string, unknown> }) => {
    if (request.query.startsWith("query RecordsOwnerBackfillPage")) {
      return {
        rows: [
          { id: "account-1", owner_user_id: null },
          { id: "account-2", owner_user_id: "user-alice" },
        ],
      };
    }
    for (const [key, value] of Object.entries(request.variables ?? {})) {
      if (key.startsWith("data_") && input.writeAudits !== false) {
        audits.add((value as Record<string, string>).nk_mutation_id);
      }
    }
    return { row_0: [{ id: "account-1" }] };
  });
  const registry = { loadApp: vi.fn(async () => snapshot()) };
  return { pool, execute, registry, audits, succeeded: () => succeeded };
}

describe("owner identity backfill", () => {
  it("updates only mismatched rows with per-record audit identities", async () => {
    const test = harness();
    const executor = new RecordOwnerBackfillExecutor({
      pool: test.pool,
      graphjin: { execute: test.execute },
      serviceToken: () => "service-token",
      leaseOwner: "worker-1",
      registry: test.registry as never,
    });

    await expect(
      executor.execute({
        actionRequestId: "request-1",
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "sf-prod",
        actorUserId: "admin-1",
      }),
    ).resolves.toMatchObject({
      mappings: 1,
      objects: 1,
      scanned: 2,
      updated: 1,
      unchanged: 1,
      skippedObjects: [],
    });
    expect(test.audits).toHaveLength(1);
    const mutation = test.execute.mock.calls.find(([request]) =>
      String(request.query).startsWith("mutation RecordsOwnerBackfillBatch"),
    )?.[0];
    expect(mutation?.query).toContain("owner_id: { eq: $source_user_0 }");
    expect(mutation?.variables).toMatchObject({
      id_0: "account-1",
      source_user_0: "005-alice",
      data_0: {
        owner_user_id: "user-alice",
        nk_updated_by: "admin-1",
        nk_action_request_id: "request-1",
      },
    });
    expect(test.succeeded()).toBe(true);
  });

  it("fails retryably when GraphJin cannot prove every attempted audit", async () => {
    const test = harness({ writeAudits: false });
    const executor = new RecordOwnerBackfillExecutor({
      pool: test.pool,
      graphjin: { execute: test.execute },
      serviceToken: () => "service-token",
      leaseOwner: "worker-1",
      registry: test.registry as never,
    });
    await expect(
      executor.execute({
        actionRequestId: "request-1",
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "sf-prod",
        actorUserId: "admin-1",
      }),
    ).rejects.toBeInstanceOf(RecordOwnerBackfillAuditError);
    expect(test.succeeded()).toBe(false);
  });

  it("refuses ambiguous multi-source ownership without row provenance", async () => {
    const test = harness({ identities: [rawIdentity("sf-prod"), rawIdentity("sf-sandbox")] });
    const executor = new RecordOwnerBackfillExecutor({
      pool: test.pool,
      graphjin: { execute: test.execute },
      serviceToken: () => "service-token",
      leaseOwner: "worker-1",
      registry: test.registry as never,
    });
    await expect(
      executor.execute({
        actionRequestId: "request-1",
        orgId: "org-a",
        appId: "crm",
        sourceInstanceId: "sf-prod",
        actorUserId: "admin-1",
      }),
    ).resolves.toMatchObject({
      objects: 0,
      updated: 0,
      skippedObjects: [
        expect.objectContaining({ objectApiName: "account", reason: expect.stringMatching(/provenance/) }),
      ],
    });
    expect(test.execute).not.toHaveBeenCalled();
  });
});
