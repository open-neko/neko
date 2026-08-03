import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRecordArtifactImportPlan,
  RecordArtifactImportPlanError,
  verifyRecordArtifactImportPlan,
} from "../src/import/artifact";
import {
  prepareRecordImportSamples,
  prepareRecordImportSource,
} from "../src/import/executor";
import type { RecordField } from "../src/types";
import {
  SALESFORCE_GOLDEN_DIRECTORY,
  SALESFORCE_GOLDEN_OBJECT_COUNT,
  SALESFORCE_GOLDEN_REJECT_COUNT,
  SALESFORCE_GOLDEN_ROW_COUNT,
  salesforceGoldenArtifactFiles,
} from "./fixtures/salesforce-golden";

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

  it("reconciles a deterministic twelve-object Salesforce migration fixture", async () => {
    const staged = salesforceGoldenArtifactFiles();
    const buildGolden = () =>
      buildRecordArtifactImportPlan({
        directory: SALESFORCE_GOLDEN_DIRECTORY,
        app: "CRM Migration",
        label: "CRM Migration",
        readFile: async (path) => {
          const bytes = staged.get(path);
          if (!bytes) throw new Error(`missing golden artifact ${path}`);
          return bytes;
        },
      });
    const first = await buildGolden();
    const second = await buildGolden();

    expect(first.definition.objects).toHaveLength(SALESFORCE_GOLDEN_OBJECT_COUNT);
    expect(first.imports).toHaveLength(SALESFORCE_GOLDEN_OBJECT_COUNT);
    expect(first.imports.reduce((total, plan) => total + plan.rowCount, 0)).toBe(
      SALESFORCE_GOLDEN_ROW_COUNT,
    );
    expect(first.planHash).toBe(second.planHash);
    expect(first.definition).toEqual(second.definition);
    expect(first.imports).toEqual(second.imports);
    expect(first.imports.every((plan) => plan.allowReadOnly === true)).toBe(true);

    const object = (apiName: string) => {
      const found = first.definition.objects.find((candidate) => candidate.apiName === apiName);
      if (!found) throw new Error(`missing golden object ${apiName}`);
      return found;
    };
    const field = (objectApiName: string, fieldApiName: string) => {
      const found = object(objectApiName).fields.find(
        (candidate) => candidate.apiName === fieldApiName,
      );
      if (!found) throw new Error(`missing golden field ${objectApiName}.${fieldApiName}`);
      return found;
    };

    expect(object("case_nk").sourceApiName).toBe("Case");
    expect(object("user_nk").sourceApiName).toBe("User");
    expect(object("subscription__c")).toMatchObject({
      sourceApiName: "Subscription__c",
      custom: true,
    });
    expect(field("task", "whatid").referenceTargets).toEqual([
      "account",
      "opportunity",
    ]);
    expect(field("task", "whoid").referenceTargets).toEqual(["contact", "lead"]);
    expect(field("campaignmember", "campaignid").referenceTargets).toEqual([
      "campaign",
    ]);
    expect(field("case_nk", "status").picklistValues).toEqual(["New", "Closed"]);
    expect(field("opportunity", "forecast__c")).toMatchObject({
      kind: "readonly_formula",
      readOnly: true,
    });
    expect(field("subscription__c", "tags__c")).toMatchObject({
      kind: "multipicklist",
      picklistValues: ["Annual", "Priority", "Trial"],
    });
    expect(first.warnings).toContain(
      "BillingAddress: compound fields use their flattened component columns",
    );

    const allCandidates = first.imports.flatMap((importPlan) => {
      const definition = object(importPlan.objectApiName);
      const fields: RecordField[] = definition.fields.map((candidate, index) => ({
        id: `${definition.apiName}-field-${index}`,
        orgId: "golden-org",
        objectId: `${definition.apiName}-object`,
        apiName: candidate.apiName,
        sourceApiName: candidate.sourceApiName,
        label: candidate.label,
        kind: candidate.kind,
        columnName: candidate.columnName,
        required: candidate.required,
        readOnly: candidate.readOnly,
        archivedAt: candidate.archived ? new Date(0) : null,
        picklistValues: candidate.picklistValues,
        referenceTargets: candidate.referenceTargets,
        length: candidate.length,
        scale: candidate.scale,
      }));
      const source = staged.get(importPlan.source.path);
      if (!source) throw new Error(`missing golden CSV ${importPlan.source.path}`);
      const prepared = prepareRecordImportSource({ plan: importPlan, source, fields });
      expect(prepareRecordImportSource({ plan: importPlan, source, fields })).toEqual(
        prepared,
      );
      expect(prepareRecordImportSamples({ plan: importPlan, fields })).toEqual(
        prepared.candidates.slice(0, importPlan.sampleRows.length),
      );
      return prepared.candidates;
    });
    const rows = allCandidates.filter((candidate) => candidate.kind === "row");
    const rejects = allCandidates.filter((candidate) => candidate.kind === "reject");

    expect(rows).toHaveLength(SALESFORCE_GOLDEN_ROW_COUNT - SALESFORCE_GOLDEN_REJECT_COUNT);
    expect(rejects).toHaveLength(SALESFORCE_GOLDEN_REJECT_COUNT);
    expect(
      rows.filter((candidate) => candidate.row.sourceRow.Email === "shared@example.com"),
    ).toHaveLength(2);
    expect(
      rows.find((candidate) => candidate.row.sourceRow.Name === "Partner lead")?.row
        .sourceRow.LeadId,
    ).toBe("021A00000000001");
    expect(rejects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reject: expect.objectContaining({
            objectApiName: "case_nk",
            rowNumber: 2,
            reasonCode: "validation",
            reason: expect.stringMatching(/configured values/i),
          }),
        }),
        expect.objectContaining({
          reject: expect.objectContaining({
            objectApiName: "product2",
            rowNumber: 2,
            reasonCode: "validation",
            reason: expect.stringMatching(/must be true/i),
          }),
        }),
      ]),
    );
  });
});
