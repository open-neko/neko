import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "@neko/records";
import { RecordAdminNav } from "@/components/records/RecordAdminNav";
import { RecordPermissionsPanel } from "@/components/records/RecordPermissionsPanel";
import { RecordSchemaHistory } from "@/components/records/RecordSchemaHistory";
import { RecordImportPanel } from "@/components/records/RecordImportPanel";

const id = validateRecordIdentifier;

describe("record app admin surfaces", () => {
  it("renders all admin routes, permission grants, and safe schema summaries", () => {
    const nav = renderToStaticMarkup(createElement(RecordAdminNav, {
      appId: "crm",
      active: "permissions",
    }));
    expect(nav).toContain("/a/crm/admin/identity");
    expect(nav).toContain("/a/crm/admin/permissions");
    expect(nav).toContain("/a/crm/admin/history");

    const permissions = renderToStaticMarkup(createElement(RecordPermissionsPanel, {
      objects: [{
        id: "object-account",
        orgId: "org-a",
        appId: "crm",
        apiName: id("account"),
        sourceApiName: null,
        label: "Account",
        pluralLabel: "Accounts",
        tableSchema: id("public"),
        tableName: id("crm__account"),
        nameField: id("name"),
        visibility: "org" as const,
        custom: false,
        archivedAt: null,
        recordCount: "1",
      }],
      permissions: [{
        appId: "crm",
        role: "member",
        objectApiName: id("account"),
        canRead: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      }],
    }));
    expect(permissions).toContain("Allowed");
    expect(permissions).toContain("Denied");
    expect(permissions).toContain("app_permission_set");

    const history = renderToStaticMarkup(createElement(RecordSchemaHistory, {
      history: [{
        id: "1",
        action: "app_field_add",
        detail: { preview: { effects: ["Add field priority"] } },
        actorUserId: "admin-1",
        actionRequestId: "request-1",
        at: "2026-08-03T12:00:00.000Z",
      }],
    }));
    expect(history).toContain("Add field priority");
    expect(history).toContain("request-1");
    expect(history).not.toContain("previewSql");

    const imports = renderToStaticMarkup(createElement(RecordImportPanel, {
      appId: "crm",
      objects: [{
        apiName: "account",
        label: "Account",
        pluralLabel: "Accounts",
        fields: [],
      }],
      recentRuns: [],
      importsEnabled: true,
      artifactImport: {
        status: "succeeded",
        validation: {
          integrity: "passed",
          rows: [{ objectApiName: "account", live: 24 }],
          sampledChecksums: [{ objectApiName: "account", verified: 5 }],
          danglingReferences: [{
            objectApiName: "contact",
            fieldApiName: "accountid",
            dangling: 1,
          }],
          unmatchedUsers: 2,
          permissionCollapse: {
            roles: [{ role: "admin" }, { role: "member" }],
          },
        },
      },
    }));
    expect(imports).toContain("Integrity verified");
    expect(imports).toContain("Live rows");
    expect(imports).toContain("24");
    expect(imports).toContain("Dangling references");
    expect(imports).toContain("admin and member");
  });
});
