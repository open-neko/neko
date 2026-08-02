import { describe, expect, it } from "vitest";
import {
  buildRecordImportPlan,
  inferRecordImportFieldKind,
  normalizeRecordImportSourcePath,
  RecordImportPlanError,
  verifyRecordImportPlanHash,
} from "../src/import/plan";
import { recordIdentifier } from "../src/naming";
import type { AppRegistrySnapshot } from "../src/types";

const objectId = "00000000-0000-0000-0000-000000000901";

function snapshot(): AppRegistrySnapshot {
  return {
    revision: "4",
    app: {
      orgId: "org-a",
      appId: "equipment",
      label: "Equipment",
      purpose: null,
      status: "active",
      navOrder: 0,
      registryRevision: "4",
    },
    objects: [
      {
        id: objectId,
        orgId: "org-a",
        appId: "equipment",
        apiName: recordIdentifier("loan"),
        sourceApiName: null,
        label: "Loan",
        pluralLabel: "Loans",
        tableSchema: recordIdentifier("public"),
        tableName: recordIdentifier("equipment__loan"),
        nameField: recordIdentifier("name"),
        visibility: "org",
        custom: false,
        archivedAt: null,
        recordCount: null,
      },
    ],
    fields: [
      {
        id: "00000000-0000-0000-0000-000000000902",
        orgId: "org-a",
        objectId,
        apiName: recordIdentifier("name"),
        sourceApiName: "Asset_Name",
        label: "Asset name",
        kind: "text",
        columnName: recordIdentifier("name"),
        required: true,
        readOnly: false,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: null,
        length: 200,
        scale: null,
      },
      {
        id: "00000000-0000-0000-0000-000000000903",
        orgId: "org-a",
        objectId,
        apiName: recordIdentifier("available"),
        sourceApiName: null,
        label: "Available",
        kind: "boolean",
        columnName: recordIdentifier("available"),
        required: false,
        readOnly: false,
        archivedAt: null,
        picklistValues: null,
        referenceTargets: null,
        length: null,
        scale: null,
      },
    ],
    layouts: [],
    pages: [],
    permissions: [],
  };
}

describe("record CSV import plans", () => {
  it("infers types conservatively", () => {
    expect(inferRecordImportFieldKind(["true", "FALSE", "yes"])).toBe("boolean");
    expect(inferRecordImportFieldKind(["1", "2", "-3"])).toBe("integer");
    expect(inferRecordImportFieldKind(["1.20", "-3.0"])).toBe("decimal");
    expect(inferRecordImportFieldKind(["1.20", "0", "-3"])).toBe("decimal");
    expect(inferRecordImportFieldKind(["2026-08-01", "2026-08-02"])).toBe("date");
    expect(inferRecordImportFieldKind(["2026-08-01T10:00:00Z"])).toBe("datetime");
    expect(inferRecordImportFieldKind(["ada@example.com"])).toBe("email");
    expect(inferRecordImportFieldKind(["https://example.com/a"])).toBe("url");
    expect(inferRecordImportFieldKind(["", ""])).toBe("text");
  });

  it("builds an immutable mapping preview with field-add suggestions", () => {
    const bytes = Buffer.from(
      "External ID,Asset_Name,Available,Purchase price\nloan-1,Laptop,true,1299.50\nloan-2,Monitor,false,399.00\n",
    );
    const plan = buildRecordImportPlan({
      snapshot: snapshot(),
      objectApiName: "loan",
      sourcePath: "uploads/thread-7/loans.csv",
      sourceName: "loans.csv",
      bytes,
      mapping: { "External ID": "id" },
      batchSize: 50,
    });

    expect(plan).toMatchObject({
      rowCount: 2,
      duplicateKey: "id",
      batchSize: 50,
    });
    expect(plan.sampleRows[0]).toEqual({
      "External ID": "loan-1",
      Asset_Name: "Laptop",
      Available: "true",
      "Purchase price": "1299.50",
    });
    expect(plan.columns.map((column) => [column.sourceColumn, column.targetField])).toEqual([
      ["External ID", "id"],
      ["Asset_Name", "name"],
      ["Available", "available"],
      ["Purchase price", null],
    ]);
    expect(plan.columns[3]?.suggestedField).toMatchObject({
      apiName: "purchase_price",
      kind: "decimal",
    });
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyRecordImportPlanHash(plan)).not.toThrow();
    expect(() =>
      verifyRecordImportPlanHash({ ...plan, batchSize: 51 }),
    ).toThrow(/changed after approval/i);
  });

  it("requires complete required-field and duplicate-key mappings", () => {
    const bytes = Buffer.from("id,available\nloan-1,true\n");
    expect(() =>
      buildRecordImportPlan({
        snapshot: snapshot(),
        objectApiName: "loan",
        sourcePath: "uploads/t/loans.csv",
        sourceName: "loans.csv",
        bytes,
      }),
    ).toThrow(/required field name/i);
    expect(() =>
      buildRecordImportPlan({
        snapshot: snapshot(),
        objectApiName: "loan",
        sourcePath: "uploads/t/loans.csv",
        sourceName: "loans.csv",
        bytes: Buffer.from("id,name\nloan-1,Laptop\n"),
        duplicateKey: "available",
      }),
    ).toThrow(/duplicate key/i);
  });

  it("confines sources to worker-visible staging directories", () => {
    expect(normalizeRecordImportSourcePath("uploads/t/a.csv")).toBe("uploads/t/a.csv");
    expect(normalizeRecordImportSourcePath("imports/run/a.csv")).toBe("imports/run/a.csv");
    for (const path of ["/tmp/a.csv", "../a.csv", "memory/a.csv", "C:\\tmp\\a.csv"]) {
      expect(() => normalizeRecordImportSourcePath(path)).toThrow(RecordImportPlanError);
    }
  });
});
