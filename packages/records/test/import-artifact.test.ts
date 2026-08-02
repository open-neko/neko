import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRecordArtifactImportPlan,
  RecordArtifactImportPlanError,
  verifyRecordArtifactImportPlan,
} from "../src/import/artifact";

const directory = "imports/salesforce/00000000-0000-4000-a000-000000000801";
const csv = Buffer.from(
  "Id,Name,OwnerId,Score__c\n001A000010khO8J,Acme,005A000010khO8J,12.50\n",
);
const describeJson = {
  name: "Account",
  label: "Account",
  labelPlural: "Accounts",
  queryable: true,
  replicateable: true,
  fields: [
    { name: "Id", label: "Account ID", type: "id", nillable: false },
    {
      name: "Name",
      label: "Account name",
      type: "string",
      length: 255,
      nillable: false,
      createable: true,
      updateable: true,
      nameField: true,
    },
    {
      name: "OwnerId",
      label: "Owner",
      type: "reference",
      referenceTo: ["User"],
      createable: true,
      updateable: true,
    },
    {
      name: "Score__c",
      label: "Score",
      type: "double",
      calculated: true,
      scale: 2,
    },
  ],
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function files(overrides: Record<string, Uint8Array> = {}) {
  const manifest = Buffer.from(
    JSON.stringify({
      format: "openneko.records.artifact.v1",
      source: {
        kind: "salesforce",
        instance_id: "salesforce-production",
        mode: "mirror",
      },
      generated_at: "2026-08-02T12:00:00.000Z",
      watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      objects: [
        {
          source_api_name: "Account",
          object_api_name: "account",
          data_path: "data/account.csv",
          describe_path: "describe/account.json",
          expected_rows: 1,
          sha256: sha256(csv),
          watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
        },
      ],
    }),
  );
  return new Map<string, Uint8Array>([
    [`${directory}/export-manifest.json`, manifest],
    [`${directory}/describe/account.json`, Buffer.from(JSON.stringify(describeJson))],
    [`${directory}/data/account.csv`, csv],
    ...Object.entries(overrides),
  ]);
}

async function build(overrides: Record<string, Uint8Array> = {}) {
  const staged = files(overrides);
  return buildRecordArtifactImportPlan({
    directory,
    app: "CRM",
    label: "CRM",
    readFile: async (path) => {
      const bytes = staged.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes;
    },
  });
}

describe("artifact-directory import planning", () => {
  it("binds manifest, describe schema, CSV mappings, and Salesforce id normalization", async () => {
    const plan = await build();
    expect(plan).toMatchObject({
      format: "openneko.records.artifact-import.v1",
      directory,
      manifest: {
        source: {
          kind: "salesforce",
          instanceId: "salesforce-production",
          mode: "mirror",
        },
      },
      definition: {
        appId: "crm",
        objects: [
          expect.objectContaining({
            apiName: "account",
            sourceApiName: "Account",
            visibility: "owner",
          }),
        ],
      },
      imports: [
        expect.objectContaining({
          appId: "crm",
          objectApiName: "account",
          rowCount: 1,
          allowReadOnly: true,
        }),
      ],
    });
    expect(plan.imports[0]?.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceColumn: "Id", targetField: "id", sourceId: true }),
        expect.objectContaining({
          sourceColumn: "OwnerId",
          targetField: "ownerid",
          sourceId: true,
        }),
        expect.objectContaining({
          sourceColumn: "Score__c",
          targetField: "score__c",
          targetKind: "readonly_formula",
        }),
      ]),
    );
    expect(plan.definition.permissions.every((permission) => !permission.canCreate)).toBe(
      true,
    );
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyRecordArtifactImportPlan(plan)).not.toThrow();
    expect(() =>
      verifyRecordArtifactImportPlan({
        ...plan,
        warnings: [...plan.warnings, "tampered"],
      }),
    ).toThrow(/changed after approval/i);
  });

  it("rejects changed CSV bytes before constructing a schema action", async () => {
    await expect(
      build({ [`${directory}/data/account.csv`]: Buffer.from(`${csv}extra,row\n`) }),
    ).rejects.toThrow(/checksum/i);
  });

  it("rejects describe/manifest identity drift and unsafe directories", async () => {
    await expect(
      build({
        [`${directory}/describe/account.json`]: Buffer.from(
          JSON.stringify({ ...describeJson, name: "Contact" }),
        ),
      }),
    ).rejects.toThrow(/belongs to Contact/i);
    await expect(
      buildRecordArtifactImportPlan({
        directory: "../escape",
        app: "crm",
        label: "CRM",
        readFile: async () => new Uint8Array(),
      }),
    ).rejects.toBeInstanceOf(RecordArtifactImportPlanError);
  });
});
