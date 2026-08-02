import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRecordsArtifactManifest } from "../src/connect/artifacts";
import { SalesforceApiClient, type SalesforceFetch } from "../src/connect/salesforce/client";
import { SalesforceConnector } from "../src/connect/salesforce/export";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const accountDescribe = {
  name: "Account",
  label: "Account",
  labelPlural: "Accounts",
  queryable: true,
  replicateable: true,
  fields: [
    { name: "Id", label: "Account ID", type: "id" },
    {
      name: "Name",
      label: "Account Name",
      type: "string",
      nameField: true,
      createable: true,
      updateable: true,
    },
    { name: "OwnerId", label: "Owner", type: "reference", referenceTo: ["User"] },
    { name: "SystemModstamp", label: "System Modstamp", type: "datetime" },
    { name: "IsDeleted", label: "Deleted", type: "boolean" },
  ],
};

function connector(fetcher: SalesforceFetch): SalesforceConnector {
  return new SalesforceConnector({
    client: new SalesforceApiClient({
      instanceUrl: "https://tenant.my.salesforce.com",
      clientId: "client",
      clientSecret: "secret",
      fetch: fetcher,
      maxRetries: 0,
    }),
    sourceInstanceId: "sf-prod",
    mode: "mirror",
    app: "CRM",
    label: "CRM",
    objects: ["Account"],
    pollIntervalMs: 0,
    now: () => new Date("2026-08-02T12:00:00.000Z"),
    sleep: async () => undefined,
  });
}

describe("Salesforce Bulk export", () => {
  it("discovers the selected object inventory with source counts", async () => {
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/services/oauth2/token")) {
        return json({
          access_token: "token",
          instance_url: "https://tenant.my.salesforce.com",
        });
      }
      if (url.pathname.endsWith("/sobjects")) {
        return json({
          sobjects: [
            {
              name: "Account",
              label: "Account",
              labelPlural: "Accounts",
              queryable: true,
              replicateable: true,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) {
        return json(accountDescribe);
      }
      if (url.pathname.endsWith("/query")) {
        expect(decodeURIComponent(url.search)).toContain("SELECT count() FROM Account");
        return json({ totalSize: 42, done: true, records: [] });
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    await expect(connector(fetcher).discover()).resolves.toEqual({
      connector: "salesforce",
      sourceInstanceId: "sf-prod",
      mode: "mirror",
      objects: [
        {
          sourceApiName: "Account",
          label: "Account",
          pluralLabel: "Accounts",
          queryable: true,
          replicateable: true,
          estimatedRows: 42,
          fields: 5,
        },
      ],
      warnings: [],
    });
  });

  it("resumes at the exact result locator and publishes a reconciled artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "records-sf-export-"));
    roots.push(root);
    let failSecondPage = true;
    let bulkCreates = 0;
    const resultLocators: Array<string | null> = [];
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/services/oauth2/token")) {
        return json({
          access_token: "token",
          instance_url: "https://tenant.my.salesforce.com",
        });
      }
      if (url.pathname.endsWith("/sobjects")) {
        return json({
          sobjects: [
            {
              name: "Account",
              label: "Account",
              labelPlural: "Accounts",
              queryable: true,
              replicateable: true,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) return json(accountDescribe);
      if (url.pathname.endsWith("/jobs/query") && init?.method === "POST") {
        bulkCreates += 1;
        expect(String(init.body)).toContain('"operation":"queryAll"');
        expect(String(init.body)).toContain("SELECT Id, Name, OwnerId");
        return json({ id: "job-1", state: "UploadComplete" });
      }
      if (url.pathname.endsWith("/jobs/query/job-1")) {
        return json({ id: "job-1", state: "JobComplete" });
      }
      if (url.pathname.endsWith("/jobs/query/job-1/results")) {
        const locator = url.searchParams.get("locator");
        resultLocators.push(locator);
        if (locator === "next" && failSecondPage) throw new Error("simulated kill");
        if (locator === "next") {
          return new Response(
            '"Id","Name","OwnerId","SystemModstamp","IsDeleted"\n"001A000010khO8J","Beta","005A000010khO8J","2026-08-02T11:00:00.000Z","false"\n',
            {
              headers: {
                "content-type": "text/csv",
                "sforce-numberofrecords": "1",
                "sforce-locator": "null",
              },
            },
          );
        }
        return new Response(
          '"Id","Name","OwnerId","SystemModstamp","IsDeleted"\n"001A000010khO8I","Acme","005A000010khO8I","2026-08-02T10:00:00.000Z","false"\n',
          {
            headers: {
              "content-type": "text/csv",
              "sforce-numberofrecords": "1",
              "sforce-locator": "next",
            },
          },
        );
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    await expect(connector(fetcher).export({ directory: root })).rejects.toThrow(
      /simulated kill/,
    );
    failSecondPage = false;
    const result = await connector(fetcher).export({ directory: root, resume: true });

    expect(bulkCreates).toBe(1);
    expect(resultLocators).toEqual([null, "next", "next"]);
    expect(result.manifest).toMatchObject({
      source: { kind: "salesforce", instanceId: "sf-prod", mode: "mirror" },
      objects: [
        {
          sourceApiName: "Account",
          objectApiName: "account",
          expectedRows: 2,
        },
      ],
    });
    const csv = await readFile(join(root, "data/account.csv"), "utf8");
    expect(csv.match(/"Id","Name"/g)).toHaveLength(1);
    expect(csv).toContain("Acme");
    expect(csv).toContain("Beta");
    const persisted = parseRecordsArtifactManifest(
      JSON.parse(await readFile(join(root, "export-manifest.json"), "utf8")),
    );
    expect(persisted).toEqual(result.manifest);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it("normalizes source and polymorphic ids while paging delta queryAll", async () => {
    let page = 0;
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/services/oauth2/token")) {
        return json({
          access_token: "token",
          instance_url: "https://tenant.my.salesforce.com",
        });
      }
      if (url.pathname.endsWith("/sobjects")) {
        return json({
          sobjects: [{ name: "Account", queryable: true, replicateable: true }],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) return json(accountDescribe);
      if (url.pathname.endsWith("/queryAll")) {
        expect(decodeURIComponent(url.search)).toContain(
          "SystemModstamp > 2026-08-01T00:00:00.000Z",
        );
        page += 1;
        return json({
          done: false,
          nextRecordsUrl: "/services/data/v64.0/queryAll/next-page",
          records: [
            {
              Id: "001A000010khO8J",
              OwnerId: "005A000010khO8J",
              Name: "Acme",
              SystemModstamp: "2026-08-02T10:00:00.000Z",
              IsDeleted: false,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/queryAll/next-page")) {
        page += 1;
        return json({
          done: true,
          records: [
            {
              Id: "001A000010khO8I",
              SystemModstamp: "2026-08-02T11:00:00.000Z",
              IsDeleted: true,
            },
          ],
        });
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    const result = await connector(fetcher).delta({
      sourceApiName: "Account",
      watermark: { system_modstamp: "2026-08-01T00:00:00.000Z" },
    });
    expect(page).toBe(2);
    expect(result.records[0]).toMatchObject({
      Id: "001A000010khO8JIAU",
      OwnerId: "005A000010khO8JIAU",
    });
    expect(result.deletedIds).toEqual(["001A000010khO8IIAU"]);
    expect(result.nextWatermark).toEqual({
      system_modstamp: "2026-08-02T11:00:00.000Z",
    });
  });
});
