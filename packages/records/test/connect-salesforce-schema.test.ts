import { describe, expect, it } from "vitest";
import {
  buildSalesforceAppSchema,
  parseSalesforceObjectDescribe,
  SalesforceDescribeError,
} from "../src/connect/salesforce/schema";

const account = {
  name: "Account",
  label: "Account",
  labelPlural: "Accounts",
  queryable: true,
  replicateable: true,
  fields: [
    { name: "Id", label: "Account ID", type: "id", nillable: false },
    {
      name: "Name",
      label: "Account Name",
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
      name: "Industry",
      label: "Industry",
      type: "picklist",
      picklistValues: [
        { value: "Energy", active: true },
        { value: "Retired", active: false },
      ],
      createable: true,
      updateable: true,
    },
    {
      name: "BillingAddress",
      label: "Billing Address",
      type: "address",
    },
  ],
};

const opportunity = {
  name: "Opportunity__c",
  label: "Opportunity",
  labelPlural: "Opportunities",
  custom: true,
  queryable: true,
  replicateable: true,
  fields: [
    { name: "Id", label: "Opportunity ID", type: "id" },
    {
      name: "Name",
      label: "Opportunity Name",
      type: "string",
      nameField: true,
      createable: true,
      updateable: true,
    },
    {
      name: "AccountId",
      label: "Account",
      type: "reference",
      referenceTo: ["Account"],
      createable: true,
      updateable: true,
    },
    {
      name: "WhoId",
      label: "Who",
      type: "reference",
      referenceTo: ["Contact", "Lead"],
    },
    {
      name: "Forecast__c",
      label: "Forecast",
      type: "currency",
      calculated: true,
      scale: 2,
    },
    { name: "Attachment__c", label: "Attachment", type: "base64" },
  ],
};

describe("Salesforce schema translation", () => {
  it("sanitizes persisted describe metadata and rejects malformed API names", () => {
    expect(parseSalesforceObjectDescribe(account)).toMatchObject({
      name: "Account",
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "OwnerId", referenceTo: ["User"] }),
      ]),
    });
    expect(() =>
      parseSalesforceObjectDescribe({
        ...account,
        fields: [...account.fields, { name: "Bad;Field", label: "Bad", type: "string" }],
      }),
    ).toThrow(SalesforceDescribeError);
  });

  it("produces an approval-ready mirror app with source fidelity", () => {
    const plan = buildSalesforceAppSchema({
      app: "CRM Mirror",
      label: "CRM Mirror",
      mode: "mirror",
      describes: [account, opportunity],
    });

    expect(plan.definition).toMatchObject({
      appId: "crm_mirror",
      objects: [
        {
          apiName: "account",
          sourceApiName: "Account",
          visibility: "owner",
          nameField: "name",
          fields: expect.arrayContaining([
            expect.objectContaining({
              apiName: "industry",
              sourceApiName: "Industry",
              kind: "picklist",
              picklistValues: ["Energy"],
            }),
          ]),
        },
        {
          apiName: "opportunity__c",
          sourceApiName: "Opportunity__c",
          custom: true,
          fields: expect.arrayContaining([
            expect.objectContaining({
              apiName: "accountid",
              kind: "reference",
              referenceTargets: ["account"],
            }),
            expect.objectContaining({
              apiName: "whoid",
              kind: "text",
            }),
            expect.objectContaining({
              apiName: "forecast__c",
              kind: "readonly_formula",
              readOnly: true,
            }),
          ]),
        },
      ],
    });
    expect(plan.definition.permissions.every((permission) => !permission.canCreate)).toBe(
      true,
    );
    expect(plan.mappings[0]?.fields).toContainEqual({
      sourceField: "Id",
      targetField: "id",
      skippedReason: null,
    });
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("BillingAddress"),
        expect.stringContaining("WhoId"),
        expect.stringContaining("Attachment__c"),
      ]),
    );
  });

  it("opens only admin writes after explicit primary-mode cutover", () => {
    const plan = buildSalesforceAppSchema({
      app: "CRM",
      label: "CRM",
      mode: "primary",
      describes: [account],
    });
    expect(plan.definition.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "admin", canCreate: true, canUpdate: true }),
        expect.objectContaining({ role: "member", canCreate: false, canUpdate: false }),
      ]),
    );
  });
});
