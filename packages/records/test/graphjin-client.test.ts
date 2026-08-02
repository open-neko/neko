import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintRecordsGraphjinToken,
  RecordsGraphjinClient,
  RecordsGraphjinRequestError,
  recordsGraphjinEndpoint,
  verifyRecordsGraphjinToken,
} from "../src/graphjin/client";

const secret = "records-test-secret-that-is-at-least-thirty-two-bytes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("records GraphJin client", () => {
  it("mints a short-lived actor token and rejects tampering or expiry", () => {
    const token = mintRecordsGraphjinToken({
      secret,
      orgId: "org-a",
      userId: "member-1",
      role: "member",
      ttlSeconds: 60,
      nowMs: 1_000_000,
    });
    expect(
      verifyRecordsGraphjinToken(token, {
        secret,
        orgId: "org-a",
        nowMs: 1_030_000,
      }),
    ).toMatchObject({
      sub: "member-1",
      org_id: "org-a",
      role: "member",
      roles: ["member"],
    });
    expect(
      verifyRecordsGraphjinToken(`${token.slice(0, -1)}x`, {
        secret,
        orgId: "org-a",
        nowMs: 1_030_000,
      }),
    ).toBeNull();
    expect(
      verifyRecordsGraphjinToken(token, {
        secret,
        orgId: "org-a",
        nowMs: 1_061_000,
      }),
    ).toBeNull();
  });

  it("normalizes only credential-free HTTP endpoints", () => {
    expect(recordsGraphjinEndpoint("http://records-graphjin:8090")).toBe(
      "http://records-graphjin:8090/api/v1/graphql",
    );
    expect(
      recordsGraphjinEndpoint("https://records.example/api/v1/graphql/"),
    ).toBe("https://records.example/api/v1/graphql");
    expect(() => recordsGraphjinEndpoint("ftp://records.example")).toThrow(/HTTP/);
    expect(() => recordsGraphjinEndpoint("https://user:pass@records.example")).toThrow(
      /credentials/,
    );
  });

  it("sends a named bearer-authenticated document without a role override", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer signed-token");
      expect(headers).not.toHaveProperty("X-Role");
      expect(headers).not.toHaveProperty("x-role");
      expect(JSON.parse(String(init.body))).toEqual({
        operationName: "RecordsRead",
        query: "query RecordsRead { equipment__loan { id } }",
        variables: { limit: 10 },
      });
      return new Response(
        JSON.stringify({ data: { equipment__loan: [{ id: "loan-1" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new RecordsGraphjinClient({ baseUrl: "http://records:8090" });

    await expect(
      client.execute<{ equipment__loan: Array<{ id: string }> }>({
        operationName: "RecordsRead",
        query: "query RecordsRead { equipment__loan { id } }",
        variables: { limit: 10 },
        token: "signed-token",
      }),
    ).resolves.toEqual({ equipment__loan: [{ id: "loan-1" }] });
  });

  it("returns typed, bounded failures without echoing response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ errors: [{ message: "permission denied", path: ["loan"] }] }),
          { status: 200 },
        ),
      ),
    );
    const client = new RecordsGraphjinClient({ baseUrl: "http://records:8090" });
    await expect(
      client.execute({
        operationName: "RecordsWrite",
        query: "mutation RecordsWrite { equipment__loan(insert: $data) { id } }",
        token: "signed-token",
      }),
    ).rejects.toMatchObject({
      name: "RecordsGraphjinRequestError",
      graphjinErrors: [{ message: "permission denied", path: ["loan"] }],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("x".repeat(101), {
          status: 200,
          headers: { "content-length": "101" },
        }),
      ),
    );
    const bounded = new RecordsGraphjinClient({
      baseUrl: "http://records:8090",
      maxResponseBytes: 100,
    });
    await expect(
      bounded.execute({
        operationName: "RecordsRead",
        query: "query RecordsRead { equipment__loan { id } }",
        token: "signed-token",
      }),
    ).rejects.toBeInstanceOf(RecordsGraphjinRequestError);
  });
});
