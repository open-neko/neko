import { describe, expect, it } from "vitest";
import {
  parseSalesforceActionConfig,
  SalesforceActionConfigError,
} from "../../src/records/salesforce-runtime.js";

describe("Salesforce action runtime", () => {
  it("normalizes a safe connector configuration without accepting a credential", () => {
    expect(
      parseSalesforceActionConfig({
        source_instance_id: "salesforce-production",
        instance_url: "https://example.my.salesforce.com",
        client_id: "client-id",
        client_secret_ref: "salesforce-secret",
        app: "crm",
        label: "CRM",
        objects: ["User", "Account"],
      }),
    ).toEqual({
      sourceInstanceId: "salesforce-production",
      instanceUrl: "https://example.my.salesforce.com",
      clientId: "client-id",
      clientSecretRef: "salesforce-secret",
      apiVersion: "64.0",
      dailyApiLimit: 10_000,
      mode: "mirror",
      app: "crm",
      label: "CRM",
      objects: ["Account", "User"],
    });
  });

  it("fails closed for malformed versions, limits, modes, and object names", () => {
    const base = {
      source_instance_id: "salesforce-production",
      instance_url: "https://example.my.salesforce.com",
      client_id: "client-id",
      client_secret_ref: "salesforce-secret",
      app: "crm",
      label: "CRM",
    };
    for (const payload of [
      { ...base, api_version: "latest" },
      { ...base, daily_api_limit: 0 },
      { ...base, mode: "write-through" },
      { ...base, objects: ["Account; DROP TABLE"] },
      { ...base, objects: ["Account", "Account"] },
    ]) {
      expect(() => parseSalesforceActionConfig(payload)).toThrow(
        SalesforceActionConfigError,
      );
    }
  });
});
