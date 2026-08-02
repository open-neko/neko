import { describe, expect, it } from "vitest";
import {
  InvalidRecordNameError,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  quoteRecordIdentifier,
  recordIdentifier,
  recordTableName,
} from "../src/naming";

describe("recordIdentifier", () => {
  it.each([
    ["Account", "account"],
    ["My_Object__c", "my_object__c"],
    ["  Equipment Loan  ", "equipment_loan"],
    ["Café Owner", "cafe_owner"],
    ["123 Status", "n_123_status"],
  ])("normalizes %j to a stable API name", (source, expected) => {
    expect(recordIdentifier(source)).toBe(expected);
  });

  it.each([
    ["select", "select_nk"],
    ["USER", "user_nk"],
    ["table", "table_nk"],
  ])("suffixes reserved identifier %j", (source, expected) => {
    expect(recordIdentifier(source)).toBe(expected);
  });

  it("removes hostile syntax rather than exposing it to the catalog", () => {
    const identifier = recordIdentifier('Name"; DROP TABLE users;--');
    expect(identifier).toBe("name_drop_table_users");
    expect(identifier).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it.each(["", "   ", "💥", "___"])('rejects empty normalized name %j', (source) => {
    expect(() => recordIdentifier(source)).toThrow(InvalidRecordNameError);
  });

  it("truncates long names with a deterministic collision-resistant suffix", () => {
    const common = "customer_contract_entitlement_".repeat(3);
    const first = recordIdentifier(`${common}alpha`);
    const second = recordIdentifier(`${common}beta`);

    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(first).toBe(recordIdentifier(`${common}alpha`));
    expect(first).not.toBe(second);
    expect(first).toMatch(/_[0-9a-f]{10}$/);
  });

  it("preserves the Salesforce custom-field suffix after truncation", () => {
    const identifier = recordIdentifier(`${"long_custom_field_".repeat(5)}__c`);
    expect(Buffer.byteLength(identifier, "utf8")).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(identifier).toMatch(/_[0-9a-f]{10}__c$/);
  });
});

describe("recordTableName", () => {
  it("uses the app-prefixed physical naming convention", () => {
    expect(recordTableName("CRM", "Account")).toBe("crm__account");
  });

  it("hashes the combined name rather than overflowing Postgres", () => {
    const table = recordTableName("very_long_application_name".repeat(3), "Account");
    expect(Buffer.byteLength(table, "utf8")).toBeLessThanOrEqual(
      POSTGRES_IDENTIFIER_MAX_BYTES,
    );
    expect(table).toMatch(/_[0-9a-f]{10}$/);
  });
});

describe("quoteRecordIdentifier", () => {
  it("quotes only branded, validated identifiers", () => {
    expect(quoteRecordIdentifier(recordIdentifier("Order"))).toBe('"order_nk"');
  });

  it("fails closed if an unsafe cast attempts to bypass naming", () => {
    expect(() => quoteRecordIdentifier('bad"name' as never)).toThrow(
      InvalidRecordNameError,
    );
  });
});
