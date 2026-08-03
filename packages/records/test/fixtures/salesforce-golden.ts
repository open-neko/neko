import { createHash } from "node:crypto";
import { recordIdentifier } from "../../src/naming";
import type {
  SalesforceFieldDescribe,
  SalesforceObjectDescribe,
} from "../../src/connect/salesforce/schema";

export const SALESFORCE_GOLDEN_DIRECTORY =
  "imports/salesforce/00000000-0000-4000-a000-000000000802";
export const SALESFORCE_GOLDEN_OBJECT_COUNT = 12;
export const SALESFORCE_GOLDEN_ROW_COUNT = 24;
export const SALESFORCE_GOLDEN_REJECT_COUNT = 2;

type GoldenObject = {
  describe: SalesforceObjectDescribe;
  rows: Array<Record<string, string>>;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceId(objectIndex: number, row: 1 | 2): string {
  return `${String(objectIndex + 1).padStart(3, "0")}A0000000000${row}`;
}

function idField(label: string): SalesforceFieldDescribe {
  return { name: "Id", label: `${label} ID`, type: "id", nillable: false };
}

function nameField(name = "Name", label = "Name"): SalesforceFieldDescribe {
  return {
    name,
    label,
    type: "string",
    length: 255,
    nillable: false,
    createable: true,
    updateable: true,
    nameField: true,
  };
}

function textField(name: string, label: string): SalesforceFieldDescribe {
  return {
    name,
    label,
    type: "string",
    length: 255,
    nillable: true,
    createable: true,
    updateable: true,
  };
}

function referenceField(
  name: string,
  label: string,
  referenceTo: string[],
): SalesforceFieldDescribe {
  return {
    name,
    label,
    type: "reference",
    nillable: true,
    createable: true,
    updateable: true,
    referenceTo,
  };
}

function picklistField(
  name: string,
  label: string,
  values: string[],
): SalesforceFieldDescribe {
  return {
    name,
    label,
    type: "picklist",
    nillable: true,
    createable: true,
    updateable: true,
    picklistValues: values.map((value) => ({ value, active: true })),
  };
}

function booleanField(name: string, label: string): SalesforceFieldDescribe {
  return {
    name,
    label,
    type: "boolean",
    nillable: true,
    createable: true,
    updateable: true,
  };
}

function describe(
  name: string,
  label: string,
  fields: SalesforceFieldDescribe[],
): SalesforceObjectDescribe {
  return {
    name,
    label,
    labelPlural: `${label}s`,
    custom: name.endsWith("__c"),
    queryable: true,
    replicateable: true,
    fields: [idField(label), ...fields],
  };
}

const ids = Object.fromEntries(
  [
    "Account",
    "Contact",
    "Opportunity",
    "Lead",
    "Case",
    "Task",
    "Event",
    "Campaign",
    "CampaignMember",
    "Product2",
    "Subscription__c",
    "User",
  ].map((name, index) => [name, [sourceId(index, 1), sourceId(index, 2)]]),
) as Record<string, [string, string]>;

function objectIds(name: string): [string, string] {
  const value = ids[name];
  if (!value) throw new Error(`missing golden ids for ${name}`);
  return value;
}

const [account1, account2] = objectIds("Account");
const [contact1, contact2] = objectIds("Contact");
const [opportunity1, opportunity2] = objectIds("Opportunity");
const [lead1, lead2] = objectIds("Lead");
const [campaign1, campaign2] = objectIds("Campaign");
const [product1, product2] = objectIds("Product2");
const [user1, user2] = objectIds("User");

const objects: GoldenObject[] = [
  {
    describe: describe("Account", "Account", [
      nameField(),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Industry", "Industry", ["Technology", "Manufacturing"]),
      {
        name: "BillingAddress",
        label: "Billing address",
        type: "address",
        nillable: true,
      },
      {
        ...textField("BillingStreet", "Billing street"),
        compoundFieldName: "BillingAddress",
      },
      {
        ...textField("BillingCity", "Billing city"),
        compoundFieldName: "BillingAddress",
      },
    ]),
    rows: [
      {
        Id: account1,
        Name: "Acme Holdings",
        OwnerId: user1,
        Industry: "Technology",
        BillingStreet: "1 Market Street",
        BillingCity: "San Francisco",
      },
      {
        Id: account2,
        Name: "Globex",
        OwnerId: user2,
        Industry: "Manufacturing",
        BillingStreet: "42 Industrial Way",
        BillingCity: "Boston",
      },
    ],
  },
  {
    describe: describe("Contact", "Contact", [
      nameField(),
      referenceField("AccountId", "Account", ["Account"]),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Status__c", "Status", ["Active", "Inactive"]),
    ]),
    rows: [
      {
        Id: contact1,
        Name: "Ada Lovelace",
        AccountId: account1,
        OwnerId: user1,
        Status__c: "Active",
      },
      {
        Id: contact2,
        Name: "Grace Hopper",
        AccountId: account2,
        OwnerId: user2,
        Status__c: "Inactive",
      },
    ],
  },
  {
    describe: describe("Opportunity", "Opportunity", [
      nameField(),
      referenceField("AccountId", "Account", ["Account"]),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("StageName", "Stage", ["Prospecting", "Closed Won"]),
      {
        name: "Forecast__c",
        label: "Forecast",
        type: "currency",
        calculated: true,
        scale: 2,
        nillable: true,
        createable: false,
        updateable: false,
      },
    ]),
    rows: [
      {
        Id: opportunity1,
        Name: "Acme Renewal",
        AccountId: account1,
        OwnerId: user1,
        StageName: "Prospecting",
        Forecast__c: "150000.00",
      },
      {
        Id: opportunity2,
        Name: "Globex Expansion",
        AccountId: account2,
        OwnerId: user2,
        StageName: "Closed Won",
        Forecast__c: "92000.50",
      },
    ],
  },
  {
    describe: describe("Lead", "Lead", [
      nameField(),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Status", "Status", ["Open", "Qualified"]),
    ]),
    rows: [
      { Id: lead1, Name: "Northwind", OwnerId: user1, Status: "Open" },
      { Id: lead2, Name: "Initech", OwnerId: user2, Status: "Qualified" },
    ],
  },
  {
    describe: describe("Case", "Case", [
      nameField("CaseNumber", "Case number"),
      referenceField("AccountId", "Account", ["Account"]),
      referenceField("ContactId", "Contact", ["Contact"]),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Status", "Status", ["New", "Closed"]),
    ]),
    rows: [
      {
        Id: objectIds("Case")[0],
        CaseNumber: "000101",
        AccountId: account1,
        ContactId: contact1,
        OwnerId: user1,
        Status: "New",
      },
      {
        Id: objectIds("Case")[1],
        CaseNumber: "000102",
        AccountId: account2,
        ContactId: contact2,
        OwnerId: user2,
        Status: "Escalated",
      },
    ],
  },
  {
    describe: describe("Task", "Task", [
      nameField("Subject", "Subject"),
      referenceField("WhatId", "Related to", ["Account", "Opportunity"]),
      referenceField("WhoId", "Name", ["Contact", "Lead"]),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Status", "Status", ["Not Started", "Completed"]),
    ]),
    rows: [
      {
        Id: objectIds("Task")[0],
        Subject: "Call Acme",
        WhatId: account1,
        WhoId: contact1,
        OwnerId: user1,
        Status: "Not Started",
      },
      {
        Id: objectIds("Task")[1],
        Subject: "Close expansion",
        WhatId: opportunity2,
        WhoId: lead2,
        OwnerId: user2,
        Status: "Completed",
      },
    ],
  },
  {
    describe: describe("Event", "Event", [
      nameField("Subject", "Subject"),
      referenceField("WhatId", "Related to", ["Account", "Opportunity"]),
      referenceField("WhoId", "Name", ["Contact", "Lead"]),
      referenceField("OwnerId", "Owner", ["User"]),
      {
        name: "StartDateTime",
        label: "Start",
        type: "datetime",
        nillable: false,
        createable: true,
        updateable: true,
      },
    ]),
    rows: [
      {
        Id: objectIds("Event")[0],
        Subject: "Acme review",
        WhatId: opportunity1,
        WhoId: contact1,
        OwnerId: user1,
        StartDateTime: "2026-08-05T10:00:00.000Z",
      },
      {
        Id: objectIds("Event")[1],
        Subject: "Globex review",
        WhatId: account2,
        WhoId: lead2,
        OwnerId: user2,
        StartDateTime: "2026-08-06T11:30:00.000Z",
      },
    ],
  },
  {
    describe: describe("Campaign", "Campaign", [
      nameField(),
      referenceField("OwnerId", "Owner", ["User"]),
      picklistField("Status", "Status", ["Planned", "In Progress"]),
    ]),
    rows: [
      { Id: campaign1, Name: "Autumn launch", OwnerId: user1, Status: "Planned" },
      { Id: campaign2, Name: "Partner day", OwnerId: user2, Status: "In Progress" },
    ],
  },
  {
    describe: describe("CampaignMember", "Campaign member", [
      nameField(),
      referenceField("CampaignId", "Campaign", ["Campaign"]),
      referenceField("ContactId", "Contact", ["Contact"]),
      referenceField("LeadId", "Lead", ["Lead"]),
      picklistField("Status", "Status", ["Sent", "Responded"]),
    ]),
    rows: [
      {
        Id: objectIds("CampaignMember")[0],
        Name: "Autumn contact",
        CampaignId: campaign1,
        ContactId: contact1,
        LeadId: "",
        Status: "Responded",
      },
      {
        Id: objectIds("CampaignMember")[1],
        Name: "Partner lead",
        CampaignId: campaign2,
        ContactId: "",
        LeadId: sourceId(20, 1),
        Status: "Sent",
      },
    ],
  },
  {
    describe: describe("Product2", "Product", [
      nameField(),
      picklistField("Family", "Family", ["Hardware", "Software"]),
      booleanField("IsActive", "Active"),
    ]),
    rows: [
      { Id: product1, Name: "Neko Gateway", Family: "Hardware", IsActive: "true" },
      {
        Id: product2,
        Name: "Neko Cloud",
        Family: "Software",
        IsActive: "not-a-boolean",
      },
    ],
  },
  {
    describe: describe("Subscription__c", "Subscription", [
      nameField(),
      referenceField("Product__c", "Product", ["Product2"]),
      {
        name: "UnitPrice__c",
        label: "Unit price",
        type: "currency",
        scale: 2,
        nillable: false,
        createable: true,
        updateable: true,
      },
      {
        ...picklistField("Tags__c", "Tags", ["Annual", "Priority", "Trial"]),
        type: "multipicklist",
      },
      booleanField("Active__c", "Active"),
    ]),
    rows: [
      {
        Id: objectIds("Subscription__c")[0],
        Name: "Gateway standard",
        Product__c: product1,
        UnitPrice__c: "499.00",
        Tags__c: "Annual;Priority",
        Active__c: "true",
      },
      {
        Id: objectIds("Subscription__c")[1],
        Name: "Cloud standard",
        Product__c: product2,
        UnitPrice__c: "99.50",
        Tags__c: "Trial",
        Active__c: "false",
      },
    ],
  },
  {
    describe: describe("User", "User", [
      nameField(),
      {
        name: "Email",
        label: "Email",
        type: "email",
        length: 320,
        nillable: false,
        createable: true,
        updateable: true,
      },
      booleanField("IsActive", "Active"),
    ]),
    rows: [
      { Id: user1, Name: "Asha Admin", Email: "shared@example.com", IsActive: "true" },
      { Id: user2, Name: "Milo Member", Email: "shared@example.com", IsActive: "true" },
    ],
  },
];

function csvBytes(object: GoldenObject): Uint8Array {
  const headers = object.describe.fields
    .filter((field) => !["address", "location", "base64"].includes(field.type.toLowerCase()))
    .map((field) => field.name);
  const lines = [
    headers.join(","),
    ...object.rows.map((row) => headers.map((header) => row[header] ?? "").join(",")),
  ];
  return Buffer.from(`${lines.join("\n")}\n`);
}

/** A deterministic, representative Salesforce export accepted by artifact planning. */
export function salesforceGoldenArtifactFiles(): Map<string, Uint8Array> {
  if (
    objects.length !== SALESFORCE_GOLDEN_OBJECT_COUNT ||
    objects.reduce((total, object) => total + object.rows.length, 0) !==
      SALESFORCE_GOLDEN_ROW_COUNT
  ) {
    throw new Error("Salesforce golden fixture counts changed");
  }
  const files = new Map<string, Uint8Array>();
  const manifestObjects = objects.map((object) => {
    const objectApiName = recordIdentifier(object.describe.name);
    const dataPath = `data/${objectApiName}.csv`;
    const describePath = `describe/${objectApiName}.json`;
    const csv = csvBytes(object);
    files.set(`${SALESFORCE_GOLDEN_DIRECTORY}/${dataPath}`, csv);
    files.set(
      `${SALESFORCE_GOLDEN_DIRECTORY}/${describePath}`,
      Buffer.from(JSON.stringify(object.describe)),
    );
    return {
      source_api_name: object.describe.name,
      object_api_name: objectApiName,
      data_path: dataPath,
      describe_path: describePath,
      expected_rows: object.rows.length,
      sha256: sha256(csv),
      watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
    };
  });
  files.set(
    `${SALESFORCE_GOLDEN_DIRECTORY}/export-manifest.json`,
    Buffer.from(
      JSON.stringify({
        format: "openneko.records.artifact.v1",
        source: {
          kind: "salesforce",
          instance_id: "salesforce-golden-production",
          mode: "mirror",
        },
        generated_at: "2026-08-02T12:00:00.000Z",
        watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
        objects: manifestObjects,
      }),
    ),
  );
  return files;
}
