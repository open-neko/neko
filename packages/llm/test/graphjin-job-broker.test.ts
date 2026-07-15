import { describe, expect, it } from "vitest";
import { assertReadOnlyGraphql } from "../src/work/control-plane";

describe("GraphJin job broker read gate", () => {
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
