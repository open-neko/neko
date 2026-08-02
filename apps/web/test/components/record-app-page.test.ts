import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "@neko/records";
import { RecordAppPage } from "@/components/records/RecordAppPage";
import type { RecordAppPageResult } from "@/lib/records";

const id = validateRecordIdentifier;

describe("RecordAppPage", () => {
  it("renders generic metric, list, and timeline blocks from compiled metadata", () => {
    const object = {
      id: "object-opportunity",
      orgId: "org-a",
      appId: "crm",
      apiName: id("opportunity"),
      sourceApiName: null,
      label: "Opportunity",
      pluralLabel: "Opportunities",
      tableSchema: id("public"),
      tableName: id("crm__opportunity"),
      nameField: id("name"),
      visibility: "org" as const,
      custom: false,
      archivedAt: null,
      recordCount: "1",
    };
    const permission = {
      appId: "crm",
      role: "admin",
      objectApiName: id("opportunity"),
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    };
    const columns = [
      {
        apiName: "name",
        columnName: "name",
        label: "Name",
        kind: "text" as const,
        required: true,
        readOnly: false,
        picklistValues: null,
        referenceTargets: null,
        scale: null,
      },
      {
        apiName: "amount",
        columnName: "amount",
        label: "Amount",
        kind: "currency" as const,
        required: false,
        readOnly: false,
        picklistValues: null,
        referenceTargets: null,
        scale: 2,
      },
    ];
    const result: RecordAppPageResult = {
      app: {
        orgId: "org-a",
        appId: "crm",
        label: "CRM",
        purpose: null,
        status: "active",
        navOrder: 0,
        registryRevision: "1",
      },
      page: {
        id: "page-overview",
        apiName: id("overview"),
        label: "Overview",
        definition: { blocks: [] },
        navOrder: 0,
      },
      blocks: [
        {
          renderer: "metric",
          label: "Open pipeline",
          span: 1,
          value: "12500.5",
          valueField: "sum_amount",
          field: columns[1]!,
        },
        {
          renderer: "list",
          label: "Closing soon",
          span: 2,
          rows: [{ id: "deal-1", name: "Meridian", amount: "12500.5" }],
          view: { object, permission, columns },
          owners: {},
        },
        {
          renderer: "timeline",
          label: "Recent activity",
          span: 3,
          rows: [{ id: "deal-1", name: "Meridian", amount: "12500.5" }],
          view: { object, permission, columns },
          owners: {},
        },
      ],
    };

    const html = renderToStaticMarkup(createElement(RecordAppPage, { result }));
    expect(html).toContain("Open pipeline");
    expect(html).toContain("12,500.50");
    expect(html).toContain("Closing soon");
    expect(html).toContain("Recent activity");
    expect(html).toContain("/a/crm/opportunity/deal-1");
    expect(html).not.toContain("crm__opportunity");
  });
});
