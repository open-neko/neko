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

function connector(
  fetcher: SalesforceFetch,
  options: { restRecordThreshold?: number; pkChunkSize?: number } = {},
): SalesforceConnector {
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
    restRecordThreshold: options.restRecordThreshold ?? 0,
    pkChunkSize: options.pkChunkSize,
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

  it("uses paged REST queryAll for a small object", async () => {
    const root = await mkdtemp(join(tmpdir(), "records-sf-rest-export-"));
    roots.push(root);
    let bulkCreates = 0;
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
          sobjects: [{ name: "Account", queryable: true, replicateable: true }],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) {
        return json(accountDescribe);
      }
      if (url.pathname.endsWith("/query")) {
        expect(decodeURIComponent(url.search)).toContain("SELECT count() FROM Account");
        return json({ totalSize: 2, done: true, records: [] });
      }
      if (url.pathname.endsWith("/jobs/query") && init?.method === "POST") {
        bulkCreates += 1;
      }
      if (url.pathname.endsWith("/queryAll")) {
        expect(decodeURIComponent(url.search)).toContain("SELECT Id, Name, OwnerId");
        return json({
          done: false,
          nextRecordsUrl: "/services/data/v64.0/queryAll/next-page",
          records: [
            {
              Id: "001A000010khO8I",
              Name: "Acme, Inc.",
              OwnerId: null,
              SystemModstamp: "2026-08-02T10:00:00.000Z",
              IsDeleted: false,
            },
          ],
        });
      }
      if (url.pathname.endsWith("/queryAll/next-page")) {
        return json({
          done: true,
          records: [
            {
              Id: "001A000010khO8J",
              Name: 'Quote "Co"',
              OwnerId: null,
              SystemModstamp: "2026-08-02T11:00:00.000Z",
              IsDeleted: false,
            },
          ],
        });
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    const result = await connector(fetcher, {
      restRecordThreshold: 2_000,
    }).export({ directory: root });

    expect(bulkCreates).toBe(0);
    expect(result.manifest.objects[0]?.expectedRows).toBe(2);
    const csv = await readFile(join(root, "data/account.csv"), "utf8");
    expect(csv.match(/"Id","Name"/g)).toHaveLength(1);
    expect(csv).toContain('"Acme, Inc."');
    expect(csv).toContain('"Quote ""Co"""');
  });

  it("falls back from a rejected Bulk 2 job to checkpointed PK chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "records-sf-pk-export-"));
    roots.push(root);
    let pkCreates = 0;
    let failSecondPkResult = true;
    const pkResultRequests: string[] = [];
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
          sobjects: [{ name: "Account", queryable: true, replicateable: true }],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) {
        return json(accountDescribe);
      }
      if (url.pathname.endsWith("/jobs/query") && init?.method === "POST") {
        return json({ id: "bulk2-job", state: "UploadComplete" });
      }
      if (url.pathname.endsWith("/jobs/query/bulk2-job")) {
        return json({ id: "bulk2-job", state: "Failed", errorMessage: "query too large" });
      }
      if (url.pathname.endsWith("/services/async/64.0/job") && init?.method === "POST") {
        pkCreates += 1;
        const headers = new Headers(init.headers);
        expect(headers.get("sforce-enable-pkchunking")).toBe("chunkSize=125000");
        expect(headers.get("x-sfdc-session")).toBe("token");
        expect(String(init.body)).toContain('"operation":"queryAll"');
        return json({ id: "pk-job", state: "Open" });
      }
      if (url.pathname.endsWith("/job/pk-job/batch") && init?.method === "POST") {
        expect(String(init.body)).toContain("SELECT Id, Name, OwnerId");
        return json({ id: "seed", state: "Queued" });
      }
      if (url.pathname.endsWith("/job/pk-job") && init?.method === "POST") {
        expect(String(init.body)).toContain('"state":"Closed"');
        return json({ id: "pk-job", state: "Closed" });
      }
      if (url.pathname.endsWith("/job/pk-job/batch")) {
        return json({
          batchInfo: [
            { id: "seed", state: "Not Processed" },
            { id: "chunk-b", state: "Completed" },
            { id: "chunk-a", state: "Completed" },
          ],
        });
      }
      if (url.pathname.endsWith("/batch/chunk-a/result")) {
        return json({ result: ["result-a"] });
      }
      if (url.pathname.endsWith("/batch/chunk-b/result")) {
        return json({ result: ["result-b"] });
      }
      if (url.pathname.endsWith("/result/result-a")) {
        pkResultRequests.push("result-a");
        return new Response(
          '"Id","Name","OwnerId","SystemModstamp","IsDeleted"\n"001A000010khO8I","Acme","","2026-08-02T10:00:00.000Z","false"\n',
          { headers: { "content-type": "text/csv" } },
        );
      }
      if (url.pathname.endsWith("/result/result-b")) {
        pkResultRequests.push("result-b");
        if (failSecondPkResult) throw new Error("simulated PK result kill");
        return new Response(
          '"Id","Name","OwnerId","SystemModstamp","IsDeleted"\n"001A000010khO8J","Beta","","2026-08-02T11:00:00.000Z","false"\n',
          { headers: { "content-type": "text/csv" } },
        );
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    await expect(
      connector(fetcher, { pkChunkSize: 125_000 }).export({ directory: root }),
    ).rejects.toThrow("simulated PK result kill");
    failSecondPkResult = false;
    const result = await connector(fetcher, { pkChunkSize: 125_000 }).export({
      directory: root,
      resume: true,
    });

    expect(pkCreates).toBe(1);
    expect(pkResultRequests).toEqual(["result-a", "result-b", "result-b"]);
    expect(result.manifest.objects[0]?.expectedRows).toBe(2);
    const csv = await readFile(join(root, "data/account.csv"), "utf8");
    expect(csv.match(/"Id","Name"/g)).toHaveLength(1);
    expect(csv).toContain("Acme");
    expect(csv).toContain("Beta");
    const checkpoint = JSON.parse(
      await readFile(join(root, "export-checkpoint.json"), "utf8"),
    ) as { objects: { Account: { strategy: string; fallbackReason: string } } };
    expect(checkpoint.objects.Account).toMatchObject({
      strategy: "pk_chunk",
      fallbackReason: expect.stringContaining("query too large"),
    });
  });

  it("uses REST as the final tail when both bulk modes are unsupported", async () => {
    const root = await mkdtemp(join(tmpdir(), "records-sf-rest-tail-"));
    roots.push(root);
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
          sobjects: [{ name: "Account", queryable: true, replicateable: true }],
        });
      }
      if (url.pathname.endsWith("/sobjects/Account/describe")) {
        return json(accountDescribe);
      }
      if (url.pathname.endsWith("/jobs/query") && init?.method === "POST") {
        return json(
          [{ errorCode: "INVALIDJOB", message: "Bulk 2 unsupported" }],
          { status: 400 },
        );
      }
      if (url.pathname.endsWith("/services/async/64.0/job") && init?.method === "POST") {
        return json(
          [{ errorCode: "InvalidEntity", message: "PK chunking unsupported" }],
          { status: 400 },
        );
      }
      if (url.pathname.endsWith("/queryAll")) {
        return json({
          done: true,
          records: [
            {
              Id: "001A000010khO8I",
              Name: "REST Tail",
              OwnerId: null,
              SystemModstamp: "2026-08-02T10:00:00.000Z",
              IsDeleted: false,
            },
          ],
        });
      }
      throw new Error(`unexpected Salesforce request: ${url}`);
    });

    const result = await connector(fetcher).export({ directory: root });
    expect(result.manifest.objects[0]?.expectedRows).toBe(1);
    await expect(readFile(join(root, "data/account.csv"), "utf8")).resolves.toContain(
      "REST Tail",
    );
    const checkpoint = JSON.parse(
      await readFile(join(root, "export-checkpoint.json"), "utf8"),
    ) as { objects: { Account: { strategy: string; fallbackReason: string } } };
    expect(checkpoint.objects.Account).toMatchObject({
      strategy: "rest",
      fallbackReason: expect.stringContaining("PK chunking unsupported"),
    });
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
