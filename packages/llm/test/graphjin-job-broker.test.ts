import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AgentControlPlane } from "../src/work/control-plane";
import {
  assertReadOnlyGraphql,
  graphjinReadPrincipal,
} from "../src/work/control-plane";
import { buildGraphjinReadServer } from "../src/work/tools";

describe("GraphJin broker read gate", () => {
  it("preserves explicit member/admin/service identities and rejects unknown roles", () => {
    expect(graphjinReadPrincipal({ userId: "member-1", role: "member" })).toEqual({
      userId: "member-1",
      role: "member",
    });
    expect(graphjinReadPrincipal({ userId: "admin-1", role: "admin" })).toEqual({
      userId: "admin-1",
      role: "admin",
    });
    expect(graphjinReadPrincipal({ userId: "service-user", role: "service" })).toEqual({
      userId: null,
      role: "service",
    });
    expect(() =>
      graphjinReadPrincipal({ userId: "unknown-1", role: null }),
    ).toThrow(/invalid role/);
    expect(() =>
      graphjinReadPrincipal({ userId: "unknown-1", role: "owner" }),
    ).toThrow(/invalid role/);
  });

  it("sends the agent-visible tool call with its trusted work-run identity", async () => {
    let seen: Parameters<AgentControlPlane["queryGraphjinRead"]>[0] | undefined;
    const controlPlane = {
      async queryGraphjinRead(input) {
        seen = input;
        return { data: { orders: [{ id: "order-1" }] } };
      },
    } as AgentControlPlane;
    const server = buildGraphjinReadServer({
      orgId: "org-1",
      runId: "run-1",
      controlPlane,
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    const client = new Client({ name: "graphjin-broker-test", version: "1" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({
        name: "execute_graphql",
        arguments: { query: "query { orders { id } }" },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("order-1");
      expect(seen).toEqual({
        orgId: "org-1",
        runId: "run-1",
        query: "query { orders { id } }",
      });
    } finally {
      await client.close();
      await server.instance.close();
    }
  });

  it("accepts explicit and shorthand query operations", () => {
    expect(() =>
      assertReadOnlyGraphql("query { orders(limit: 1) { id } }"),
    ).not.toThrow();
    expect(() =>
      assertReadOnlyGraphql("{ gj_catalog(id: \"help:discovery\") { id } }"),
    ).not.toThrow();
  });

  it.each([
    "mutation { orders(insert: { id: 1 }) { id } }",
    "subscription { orders { id } }",
    "query { run(operation: \"mutation\") }",
  ])("rejects anything carrying a write/stream operation: %s", (query) => {
    expect(() => assertReadOnlyGraphql(query)).toThrow(/query operations only/);
  });

  it("rejects non-query documents", () => {
    expect(() => assertReadOnlyGraphql("fragment Fields on Order { id }")).toThrow(
      /explicit query operation/,
    );
  });
});
