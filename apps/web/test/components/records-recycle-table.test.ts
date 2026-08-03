import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordRecycleTable } from "@/components/records/RecordRecycleTable";

describe("generated records recycle table", () => {
  it("renders only restore identity and deletion metadata with encoded links", () => {
    const html = renderToStaticMarkup(
      createElement(RecordRecycleTable, {
        appId: "support_lab",
        objectApiName: "support_case",
        objectPluralLabel: "Support cases",
        rows: [
          {
            appId: "support_lab",
            objectApiName: "support_case",
            recordId: "case/雪",
            recordName: "Damaged delivery",
            ownerUserId: "member-1",
            deletedAt: "2026-08-02T12:00:00.000Z",
            deletedBy: "admin-1",
          },
        ],
        owners: {
          "member-1": {
            userId: "member-1",
            label: "Rina Patel",
            email: "rina@example.com",
            status: "linked",
          },
        },
        total: 1,
        cursor: null,
        page: 1,
        query: {},
      }),
    );

    expect(html).toContain("Damaged delivery");
    expect(html).toContain("case/雪");
    expect(html).toContain("Rina Patel");
    expect(html).toContain("admin-1");
    expect(html).toContain("case%2F%E9%9B%AA");
    expect(html).not.toContain("business payload");
  });
});
