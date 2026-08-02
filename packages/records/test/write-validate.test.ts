import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "../src/naming";
import type { RecordField, RecordFieldKind } from "../src/types";
import {
  RecordValidationError,
  validateRecordFields,
} from "../src/write/validate";

function field(
  apiName: string,
  kind: RecordFieldKind,
  overrides: Partial<RecordField> = {},
): RecordField {
  return {
    id: `field-${apiName}`,
    orgId: "org-a",
    objectId: "object-1",
    apiName: validateRecordIdentifier(apiName),
    sourceApiName: null,
    label: apiName,
    kind,
    columnName: validateRecordIdentifier(apiName),
    required: false,
    readOnly: false,
    archivedAt: null,
    picklistValues: null,
    referenceTargets: null,
    length: null,
    scale: null,
    ...overrides,
  };
}

describe("validateRecordFields", () => {
  it("maps API fields to physical columns and returns reference checks", () => {
    const fields = [
      field("name", "text", { required: true, length: 20 }),
      field("stage", "picklist", { picklistValues: ["new", "active"] }),
      field("tags", "multipicklist", { picklistValues: ["red", "blue"] }),
      field("account", "reference", {
        columnName: validateRecordIdentifier("account_id"),
        referenceTargets: ["account"],
      }),
      field("due_at", "datetime"),
    ];
    expect(
      validateRecordFields({
        operation: "create",
        registryFields: fields,
        values: {
          id: "loan-1",
          name: "Laptop",
          stage: "active",
          tags: ["red", "blue"],
          account: "account-1",
          due_at: "2026-08-02T10:30:00+05:30",
        },
      }),
    ).toEqual({
      fields: {
        id: "loan-1",
        name: "Laptop",
        stage: "active",
        tags: ["red", "blue"],
        account_id: "account-1",
        due_at: "2026-08-02T05:00:00.000Z",
      },
      references: [
        {
          fieldApiName: "account",
          value: "account-1",
          targetObjectApiNames: ["account"],
        },
      ],
    });
  });

  it("collects required, unknown, archived, and read-only failures", () => {
    const fields = [
      field("name", "text", { required: true }),
      field("formula", "readonly_formula", { readOnly: true }),
      field("retired", "text", { archivedAt: new Date() }),
    ];
    expect(() =>
      validateRecordFields({
        operation: "create",
        registryFields: fields,
        values: { formula: "no", retired: "no", mystery: "no" },
      }),
    ).toThrow(RecordValidationError);
    try {
      validateRecordFields({
        operation: "create",
        registryFields: fields,
        values: { formula: "no", retired: "no", mystery: "no" },
      });
    } catch (error) {
      expect((error as RecordValidationError).issues.map((entry) => entry.code)).toEqual([
        "read_only",
        "unknown",
        "unknown",
        "required",
      ]);
    }
  });

  it.each([
    [field("enabled", "boolean"), "yes", "type"],
    [field("count", "integer"), 1.2, "type"],
    [field("amount", "currency", { length: 5, scale: 2 }), "123.456", "scale"],
    [field("date", "date"), "2026-02-30", "date"],
    [field("email", "email"), "not-an-email", "email"],
    [field("site", "url"), "file:///tmp/no", "url"],
    [field("status", "picklist", { picklistValues: ["open"] }), "closed", "picklist"],
    [field("labels", "multipicklist", { picklistValues: ["a"] }), ["a", "a"], "duplicate"],
  ])("rejects invalid %s values", (registryField, value, code) => {
    try {
      validateRecordFields({
        operation: "update",
        registryFields: [registryField],
        values: { [registryField.apiName]: value },
      });
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordValidationError);
      expect((error as RecordValidationError).issues[0]?.code).toBe(code);
    }
  });

  it("rejects empty updates and null required values", () => {
    const required = field("name", "text", { required: true });
    expect(() =>
      validateRecordFields({ operation: "update", registryFields: [required], values: {} }),
    ).toThrow(/at least one/);
    expect(() =>
      validateRecordFields({
        operation: "update",
        registryFields: [required],
        values: { name: null },
      }),
    ).toThrow(/cannot be null/);
  });

  it("accepts registry-enriched picklist entries by their stable value", () => {
    const fields = [
      field("status", "picklist", {
        picklistValues: [
          { value: "open", label: "Open", color: "green" },
          { value: "closed", label: "Closed", color: "slate" },
        ],
      }),
      field("tags", "multipicklist", {
        picklistValues: [
          { value: "urgent", label: "Urgent" },
          { value: "onsite", label: "On site" },
        ],
      }),
    ];
    expect(
      validateRecordFields({
        operation: "update",
        registryFields: fields,
        values: { status: "open", tags: ["urgent", "onsite"] },
      }).fields,
    ).toEqual({ status: "open", tags: ["urgent", "onsite"] });
  });
});
