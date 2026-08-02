import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "../src/naming";
import { buildRecordsGraphjinDdl } from "../src/schema/ddl";

const id = validateRecordIdentifier;

describe("buildRecordsGraphjinDdl", () => {
  it("projects deterministic additive DDL with records audit conventions", () => {
    const ddl = buildRecordsGraphjinDdl([
      {
        appId: "equipment",
        apiName: id("loan"),
        tableName: id("equipment__loan"),
        nameField: id("name"),
        visibility: "owner",
        fields: [
          { columnName: id("id"), kind: "id", required: true },
          { columnName: id("name"), kind: "text", required: true },
          { columnName: id("borrower_id"), kind: "reference", required: false },
          { columnName: id("replacement_cost"), kind: "currency", required: false },
          { columnName: id("tags"), kind: "multipicklist", required: false },
          { columnName: id("retired_note"), kind: "text", required: false, archived: true },
        ],
      },
    ]);

    expect(ddl).toContain("type equipment__loan {");
    expect(ddl).toContain("id: Text! @id");
    expect(ddl).toContain("owner_user_id: Text!");
    expect(ddl).toContain('borrower_id: Text @index(name: "idx_equipment__loan_borrower_id")');
    expect(ddl).toContain('name: Text! @index(name: "idx_equipment__loan_name")');
    expect(ddl).toContain('replacement_cost: Numeric @type(args: "38, 2")');
    expect(ddl).toContain("tags: Jsonb");
    expect(ddl).toContain("nk_action_request_id: Text!");
    expect(ddl).toContain("nk_mutation_id: Text!");
    expect(ddl).toContain("nk_deleted_at: Timestamptz");
    expect(ddl).not.toContain("retired_note");
    expect(ddl).not.toContain("@default");
    expect(ddl).not.toContain("@relation");
    expect(ddl).not.toContain("[");
  });

  it("omits archived objects without authoring destructive DDL", () => {
    const ddl = buildRecordsGraphjinDdl([
      {
        appId: "crm",
        apiName: id("account"),
        tableName: id("crm__account"),
        nameField: id("name"),
        visibility: "org",
        fields: [{ columnName: id("name"), kind: "text", required: true }],
      },
      {
        appId: "crm",
        apiName: id("legacy"),
        tableName: id("crm__legacy"),
        nameField: id("name"),
        visibility: "org",
        archived: true,
        fields: [{ columnName: id("name"), kind: "text", required: false }],
      },
    ]);
    expect(ddl).toContain("crm__account");
    expect(ddl).not.toContain("crm__legacy");
  });

  it("represents an all-archived registry without requesting table drops", () => {
    const ddl = buildRecordsGraphjinDdl([
      {
        appId: "crm",
        apiName: id("legacy"),
        tableName: id("crm__legacy"),
        nameField: id("name"),
        visibility: "org",
        archived: true,
        fields: [{ columnName: id("name"), kind: "text", required: false }],
      },
    ]);
    expect(ddl).toMatch(/^# No live records objects/);
    expect(ddl).not.toMatch(/\bDROP\b/i);
  });

  it("rejects malformed, duplicate, or system-column fields", () => {
    const base = {
      appId: "crm",
      apiName: id("account"),
      tableName: id("crm__account"),
      nameField: id("name"),
      visibility: "org" as const,
    };
    expect(() =>
      buildRecordsGraphjinDdl([
        {
          ...base,
          fields: [{ columnName: id("org_id"), kind: "text", required: true }],
        },
      ]),
    ).toThrow(/system column/);
    expect(() =>
      buildRecordsGraphjinDdl([
        {
          ...base,
          fields: [
            { columnName: id("name"), kind: "text", required: true },
            { columnName: id("name"), kind: "text", required: false },
          ],
        },
      ]),
    ).toThrow(/duplicate/);
  });
});
