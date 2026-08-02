import { describe, expect, it } from "vitest";
import {
  RecordSchemaDefinitionError,
  parseRecordAppDefinition,
  recordAppDefinitionDdlObjects,
} from "../src/schema/definition";

function appPayload(): Record<string, unknown> {
  return {
    app: "Customer Success",
    label: "Customer Success",
    purpose: "Replace the legacy support tracker",
    objects: [
      {
        name: "Account",
        source_api_name: "Account",
        label: "Account",
        fields: [
          {
            name: "Name",
            source_api_name: "Name",
            label: "Account name",
            required: true,
          },
        ],
      },
      {
        name: "Ticket",
        label: "Ticket",
        visibility: "owner",
        name_field: "Subject",
        fields: [
          { name: "Subject", label: "Subject", required: true },
          {
            name: "Account Id",
            label: "Account",
            kind: "reference",
            reference_targets: ["Account"],
          },
          {
            name: "Status",
            label: "Status",
            kind: "picklist",
            picklist_values: ["New", "Closed"],
          },
        ],
      },
    ],
  };
}

describe("records app definitions", () => {
  it("normalizes a complete app into permanent names and least-privilege defaults", () => {
    const definition = parseRecordAppDefinition(appPayload());
    expect(definition).toMatchObject({
      appId: "customer_success",
      label: "Customer Success",
      objects: [
        {
          apiName: "account",
          sourceApiName: "Account",
          tableName: "customer_success__account",
          fields: [expect.objectContaining({ sourceApiName: "Name" })],
        },
        {
          apiName: "ticket",
          tableName: "customer_success__ticket",
          nameField: "subject",
          visibility: "owner",
        },
      ],
    });
    expect(definition.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "member",
          objectApiName: "ticket",
          canRead: true,
          canCreate: false,
        }),
      ]),
    );
    expect(recordAppDefinitionDdlObjects(definition)).toHaveLength(2);
  });

  it("sanitizes hostile source labels before they become identifiers", () => {
    const payload = appPayload();
    payload.app = 'CRM"; DROP TABLE engine.actor; --';
    const definition = parseRecordAppDefinition(payload);
    expect(definition.appId).toBe("crm_drop_table_engine_actor");
    expect(definition.objects[0]?.tableName).toBe(
      "crm_drop_table_engine_actor__account",
    );
  });

  it("rejects duplicate identifiers after normalization", () => {
    const payload = appPayload();
    payload.objects = [
      { name: "Case Status", fields: [{ name: "Name" }] },
      { name: "case-status", fields: [{ name: "Name" }] },
    ];
    expect(() => parseRecordAppDefinition(payload)).toThrow(
      RecordSchemaDefinitionError,
    );
  });

  it("rejects dangling references and incomplete picklists", () => {
    const dangling = appPayload();
    dangling.objects = [
      {
        name: "Ticket",
        fields: [
          {
            name: "Account",
            kind: "reference",
            reference_targets: ["Missing"],
          },
        ],
      },
    ];
    expect(() => parseRecordAppDefinition(dangling)).toThrow(/unknown reference target/);

    const picklist = appPayload();
    picklist.objects = [
      { name: "Ticket", fields: [{ name: "Status", kind: "picklist" }] },
    ];
    expect(() => parseRecordAppDefinition(picklist)).toThrow(/picklist_values/);
  });
});
