import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "../src/naming";
import {
  buildRecordDetailQuery,
  buildRecordListQuery,
  buildRecordRecycleDetailQuery,
  buildRecordRecycleListQuery,
  RecordReadPermissionError,
  RecordReadTargetError,
} from "../src/read/query";
import type { AppRegistrySnapshot } from "../src/types";

const id = validateRecordIdentifier;

function snapshot(): AppRegistrySnapshot {
  return {
    revision: "4",
    app: {
      orgId: "org-a",
      appId: "operations",
      label: "Field Operations",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "4",
    },
    objects: [
      {
        id: "object-work-order",
        orgId: "org-a",
        appId: "operations",
        apiName: id("work_order"),
        sourceApiName: null,
        label: "Work order",
        pluralLabel: "Work orders",
        tableSchema: id("public"),
        tableName: id("operations__work_order"),
        nameField: id("subject"),
        visibility: "owner",
        custom: true,
        archivedAt: null,
        recordCount: "12",
      },
    ],
    fields: [
      {
        id: "field-subject",
        orgId: "org-a",
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
      },
      {
        id: "field-status",
        orgId: "org-a",
        objectId: "object-work-order",
        apiName: id("status"),
        sourceApiName: null,
        label: "Current status",
        kind: "picklist",
        columnName: id("status"),
        required: false,
        readOnly: false,
        archivedAt: null,
        picklistValues: ["new", "closed"],
        referenceTargets: null,
        length: null,
        scale: null,
      },
      {
        id: "field-old",
        orgId: "org-a",
        objectId: "object-work-order",
        apiName: id("old_status"),
        sourceApiName: null,
        label: "Old status",
        kind: "text",
        columnName: id("old_status"),
        required: false,
        readOnly: false,
        archivedAt: new Date(),
        picklistValues: null,
        referenceTargets: null,
        length: null,
        scale: null,
      },
    ],
    layouts: [
      {
        objectId: "object-work-order",
        kind: "list",
        definition: { columns: [{ field: "status" }, "subject", "missing"] },
      },
      {
        objectId: "object-work-order",
        kind: "detail",
        definition: { sections: [{ fields: ["subject", "status"] }] },
      },
    ],
    pages: [],
    permissions: [
      {
        appId: "operations",
        role: "admin",
        objectApiName: id("work_order"),
        canRead: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      },
      {
        appId: "operations",
        role: "member",
        objectApiName: id("work_order"),
        canRead: false,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      },
    ],
  };
}

describe("generated record read queries", () => {
  it("builds a bounded, layout-driven list query with bound filter values", () => {
    const built = buildRecordListQuery({
      snapshot: snapshot(),
      objectApiName: "work_order",
      role: "admin",
      userId: "admin-1",
      first: 25,
      after: "opaque-cursor",
      search: "50%_ready",
      sort: { field: "status", direction: "desc" },
      filters: [{ field: "status", operator: "in", value: ["new"] }],
      myRecords: true,
    });

    expect(built.view.columns.map((column) => column.apiName)).toEqual([
      "status",
      "subject",
      "owner_user_id",
    ]);
    expect(built.query).toContain(
      "rows: operations__work_order(first: $first, after: $after",
    );
    expect(built.query).toContain("order_by: { status: desc, id: desc }");
    expect(built.query).toContain("operations__work_order_cursor");
    expect(built.query).toContain("totals: operations__work_order");
    expect(built.query).toContain("count_id");
    expect(built.query).not.toContain("50%_ready");
    expect(built.variables).toEqual({
      first: 25,
      after: "opaque-cursor",
      search: "%50\\%\\_ready%",
      viewer_id: "admin-1",
      filter_0: ["new"],
    });
  });

  it("builds detail fields from sections and includes generic substrate metadata", () => {
    const built = buildRecordDetailQuery({
      snapshot: snapshot(),
      objectApiName: "work_order",
      role: "admin",
      recordId: "wo-1",
    });
    expect(built.query).toContain("id subject status owner_user_id nk_updated_at");
    expect(built.variables).toEqual({ record_id: "wo-1" });
  });

  it("builds fixed, bound recycle-bin list and detail queries", () => {
    const list = buildRecordRecycleListQuery({
      snapshot: snapshot(),
      objectApiName: "work_order",
      role: "admin",
      first: 20,
      after: "recycle-cursor",
      search: "camera%_",
    });
    expect(list.query).toContain("query RecordsRecycleList");
    expect(list.query).toContain("rows: recycle_record(first: $first, after: $after");
    expect(list.query).toContain("order_by: { deleted_at: desc, record_id: asc }");
    expect(list.query).toContain("count: count_record_id");
    expect(list.query).not.toContain("camera%_");
    expect(list.query).not.toContain("subject");
    expect(list.variables).toEqual({
      app_id: "operations",
      object_api_name: "work_order",
      first: 20,
      after: "recycle-cursor",
      search: "%camera\\%\\_%",
    });

    const detail = buildRecordRecycleDetailQuery({
      snapshot: snapshot(),
      objectApiName: "work_order",
      role: "admin",
      recordId: "wo-deleted",
    });
    expect(detail.query).toContain("query RecordsRecycleDetail");
    expect(detail.query).toContain("record_id: { eq: $record_id }");
    expect(detail.query).not.toContain("wo-deleted");
    expect(detail.variables).toEqual({
      app_id: "operations",
      object_api_name: "work_order",
      record_id: "wo-deleted",
    });
  });

  it("treats an explicit stale layout as a fail-closed field allowlist", () => {
    const current = snapshot();
    current.layouts = [
      {
        objectId: "object-work-order",
        kind: "list",
        definition: { columns: ["missing", "old_status", "not valid"] },
      },
    ];
    const built = buildRecordListQuery({
      snapshot: current,
      objectApiName: "work_order",
      role: "admin",
      userId: "admin-1",
    });

    expect(built.view.columns.map((column) => column.apiName)).toEqual([
      "owner_user_id",
    ]);
    expect(built.query).toContain("{ id owner_user_id }");
    expect(built.query).not.toContain("old_status");
  });

  it("fails closed for unreadable roles, unknown identifiers, and unsafe budgets", () => {
    expect(() =>
      buildRecordListQuery({
        snapshot: snapshot(),
        objectApiName: "work_order",
        role: "member",
        userId: "member-1",
      }),
    ).toThrow(RecordReadPermissionError);
    expect(() =>
      buildRecordListQuery({
        snapshot: snapshot(),
        objectApiName: "work_order) { secret }",
        role: "admin",
        userId: "admin-1",
      }),
    ).toThrow(RecordReadTargetError);
    expect(() =>
      buildRecordListQuery({
        snapshot: snapshot(),
        objectApiName: "work_order",
        role: "admin",
        userId: "admin-1",
        first: 101,
      }),
    ).toThrow(/between 1 and 100/);
  });
});
