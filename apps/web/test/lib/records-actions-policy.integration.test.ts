import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import {
  action_policy,
  action_request,
  and,
  db,
  eq,
  pool,
  sql,
} from "@neko/db";
import { validateRecordIdentifier, type AppRegistrySnapshot } from "@neko/records";

const mocks = vi.hoisted(() => ({
  actor: vi.fn(async () => ({ userId: "admin-1", role: "admin" })),
  approve: vi.fn(),
  shell: vi.fn(),
}));

vi.mock("@/lib/actor", () => ({ getCurrentActor: mocks.actor }));
vi.mock("@neko/llm/workflows", () => ({ approveActionRequest: mocks.approve }));
vi.mock("@/lib/records", () => {
  class RecordAppRouteError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  }
  return {
    loadRecordAppShell: mocks.shell,
    readRecordDetail: vi.fn(),
    readRecordRecycleDetail: vi.fn(),
    RecordAppRouteError,
  };
});

import {
  RecordFormPolicyError,
  submitRecordFormAction,
} from "@/lib/records-actions";

const id = validateRecordIdentifier;
const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

function snapshot(orgId: string): AppRegistrySnapshot {
  return {
    revision: "1",
    app: {
      orgId,
      appId: "operations",
      label: "Field Operations",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "1",
    },
    objects: [{
      id: "object-work-order",
      orgId,
      appId: "operations",
      apiName: id("work_order"),
      sourceApiName: null,
      label: "Work order",
      pluralLabel: "Work orders",
      tableSchema: id("public"),
      tableName: id("operations__work_order"),
      nameField: id("subject"),
      visibility: "org",
      custom: false,
      archivedAt: null,
      recordCount: "0",
    }],
    fields: [{
      id: "field-subject",
      orgId,
      objectId: "object-work-order",
      apiName: id("subject"),
      sourceApiName: null,
      label: "Subject",
      kind: "text",
      columnName: id("subject"),
      required: true,
      readOnly: false,
      archivedAt: null,
      picklistValues: null,
      referenceTargets: null,
      length: 200,
      scale: null,
    }],
    layouts: [{
      objectId: "object-work-order",
      kind: "detail",
      definition: { sections: [{ fields: ["subject"] }] },
    }],
    pages: [],
    permissions: [{
      appId: "operations",
      role: "admin",
      objectApiName: id("work_order"),
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    }],
  };
}

if (!reachable) {
  console.warn("[records-actions-policy] skipping: metadata Postgres unreachable.");
}

describeIfDb("generated record form policy integration", () => {
  let orgId: string;

  beforeAll(async () => {
    orgId = uniqueOrgId("records-form-deny");
    await createTestOrg(orgId);
    mocks.shell.mockResolvedValue({
      snapshot: snapshot(orgId),
      metadataStatus: "active",
      availability: "active",
      degradedReason: null,
      config: {},
    });
    await db().insert(action_policy).values({
      org_id: orgId,
      name: "deny_generated_record_create",
      description: "Integration proof that form writes obey stored policy.",
      applies_to_kinds: ["record_create"],
      applies_to_scopes: ["internal"],
      mode: "never",
      priority: 1,
      enabled: true,
    });
  });

  afterAll(async () => {
    await deleteTestOrg(orgId);
    await pool().end();
  });

  it("blocks before creating or approving an action request", async () => {
    await expect(submitRecordFormAction({
      orgId,
      appId: "operations",
      objectApiName: "work_order",
      operation: "create",
      fields: { subject: "Inspect loading dock" },
    })).rejects.toBeInstanceOf(RecordFormPolicyError);

    const [created] = await db()
      .select({ count: sql<number>`count(*)::int` })
      .from(action_request)
      .where(and(
        eq(action_request.org_id, orgId),
        eq(action_request.kind, "record_create"),
      ));
    expect(created?.count).toBe(0);
    expect(mocks.approve).not.toHaveBeenCalled();
  });
});
