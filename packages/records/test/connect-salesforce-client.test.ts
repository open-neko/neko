import { describe, expect, it, vi } from "vitest";
import {
  SalesforceApiBudgetExceededError,
  SalesforceApiClient,
  SalesforceApiGovernor,
} from "../src/connect/salesforce/client";

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("Salesforce API client", () => {
  it("caches credentials and honors Retry-After without leaking the secret", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/services/oauth2/token")) {
        expect(String(init?.body)).toContain("client_secret=super-secret");
        return json({
          access_token: "token-1",
          instance_url: "https://tenant.my.salesforce.com",
          expires_in: 600,
        });
      }
      if (calls.filter((call) => call.url.includes("/services/data/")).length === 1) {
        return json([{ errorCode: "REQUEST_LIMIT_EXCEEDED", message: "slow down" }], {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
      return json({ sobjects: [] });
    });
    const governor = new SalesforceApiGovernor(10, {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const client = new SalesforceApiClient({
      instanceUrl: "https://tenant.my.salesforce.com",
      clientId: "client-1",
      clientSecret: "super-secret",
      fetch: fetcher,
      sleep,
      governor,
    });

    await expect(client.json(client.dataPath("/sobjects"))).resolves.toEqual({
      sobjects: [],
    });
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(calls.filter((call) => call.url.endsWith("/services/oauth2/token"))).toHaveLength(
      1,
    );
    expect(governor.snapshot()).toMatchObject({ day: "2026-08-02", used: 3 });
    expect(JSON.stringify(calls.map((call) => call.url))).not.toContain("super-secret");
  });

  it("fails closed on egress hosts and daily budget exhaustion", async () => {
    expect(
      () =>
        new SalesforceApiClient({
          instanceUrl: "https://salesforce.example.evil.test",
          clientId: "client",
          clientSecret: "secret",
        }),
    ).toThrow(/not allowlisted/);

    const fetcher = vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("/services/oauth2/token")) {
        return json({
          access_token: "token",
          instance_url: "https://tenant.salesforce.com",
        });
      }
      return json({ ok: true });
    });
    const client = new SalesforceApiClient({
      instanceUrl: "https://tenant.salesforce.com",
      clientId: "client",
      clientSecret: "secret",
      fetch: fetcher,
      governor: new SalesforceApiGovernor(2),
    });
    await client.json(client.dataPath("/limits"));
    await expect(client.json(client.dataPath("/limits"))).rejects.toBeInstanceOf(
      SalesforceApiBudgetExceededError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("restores the same-day governor checkpoint and resets an older day", () => {
    const now = () => new Date("2026-08-02T12:00:00.000Z");
    const restored = new SalesforceApiGovernor(10, { now });
    restored.restore({ day: "2026-08-02", used: 7, limit: 10 });
    restored.consume();
    expect(restored.snapshot().used).toBe(8);

    restored.restore({ day: "2026-08-01", used: 9, limit: 10 });
    expect(restored.snapshot()).toMatchObject({ day: "2026-08-02", used: 0 });
  });
});
