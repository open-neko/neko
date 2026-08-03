import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PendingChangeMarker } from "@/components/records/PendingChangeMarker";
import {
  parseRecordUpdatePayload,
  RecordActionDiff,
} from "@/components/records/RecordActionDiff";
import {
  groupPendingRecordActions,
  isPendingRecordActionStatus,
} from "@/lib/records-pending";

describe("pending record action surfaces", () => {
  it("merges only nonterminal actions for the exact app, object, and record", () => {
    const common = {
      kind: "record_update",
      summary: "Update Meridian",
      createdAt: new Date("2026-08-03T12:00:00.000Z"),
    };
    const grouped = groupPendingRecordActions({
      appId: "crm",
      objectApiName: "account",
      recordIds: ["account-1", "account-2"],
      rows: [
        {
          ...common,
          id: "request-pending",
          status: "pending_approval",
          payload: {
            app: "crm",
            object: "account",
            id: "account-1",
            fields: { industry: "Technology" },
            expected: { industry: "Retail" },
          },
        },
        {
          ...common,
          id: "request-executed",
          status: "executed",
          payload: { app: "crm", object: "account", id: "account-1" },
        },
        {
          ...common,
          id: "request-other-object",
          status: "approved",
          payload: { app: "crm", object: "contact", id: "account-1" },
        },
        {
          ...common,
          id: "request-off-page",
          status: "draft",
          payload: { app: "crm", object: "account", id: "account-3" },
        },
      ],
    });

    expect(grouped).toEqual({
      "account-1": [expect.objectContaining({
        id: "request-pending",
        fields: { industry: "Technology" },
        expected: { industry: "Retail" },
      })],
    });
    expect(isPendingRecordActionStatus("approved")).toBe(true);
    expect(isPendingRecordActionStatus("rejected")).toBe(false);
    expect(isPendingRecordActionStatus("executed")).toBe(false);
  });

  it("renders a review link and a readable field-level diff", () => {
    const action = {
      id: "request-1",
      kind: "record_update" as const,
      status: "pending_approval" as const,
      summary: "Update Meridian",
      fields: { stage_name: "Negotiation", active: true },
      expected: { stage_name: "Proposal", active: false },
      createdAt: "2026-08-03T12:00:00.000Z",
    };
    const marker = renderToStaticMarkup(createElement(PendingChangeMarker, {
      actions: [action],
    }));
    expect(marker).toContain("/actions/request-1");
    expect(marker).toContain("Pending change");

    const payload = {
      app: "crm",
      object: "opportunity",
      id: "deal-1",
      fields: action.fields,
      expected: action.expected,
    };
    expect(parseRecordUpdatePayload("record_update", payload)).toEqual(payload);
    const diff = renderToStaticMarkup(createElement(RecordActionDiff, {
      kind: "record_update",
      payload,
    }));
    expect(diff).toContain("stage name");
    expect(diff).toContain("Proposal");
    expect(diff).toContain("Negotiation");
    expect(diff).toContain("No");
    expect(diff).toContain("Yes");
    expect(diff).toContain("rechecked immediately before write");
    expect(diff).not.toContain("[object Object]");
  });
});
