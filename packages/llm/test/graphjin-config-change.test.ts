import { describe, expect, it, vi } from "vitest";
import {
  buildGraphjinConfigUpdate,
  graphjinConfigPatchHash,
  graphjinInputValue,
} from "../src/graphjin/config-change";

describe("GraphJin config change compiler", () => {
  it("builds additive source-access patches", async () => {
    const result = await buildGraphjinConfigUpdate({
      action: "set_source_access",
      source: "adventureworks",
      read: "authenticated",
      write: "blocked",
    });
    expect(result.update).toEqual({
      source_patches: [
        {
          name: "adventureworks",
          access: { read: "authenticated", write: "blocked" },
        },
      ],
    });
  });

  it("resolves a secret by name without accepting a literal value", async () => {
    const resolve = vi.fn(async () => "super-secret-value");
    const result = await buildGraphjinConfigUpdate(
      {
        action: "register_source",
        name: "warehouse",
        kind: "database",
        host: "warehouse-db",
        secretRef: "WAREHOUSE_PASSWORD",
      },
      resolve,
    );
    expect(resolve).toHaveBeenCalledWith("WAREHOUSE_PASSWORD");
    expect(result.secretName).toBe("WAREHOUSE_PASSWORD");
    expect(JSON.stringify(result.update)).toContain("super-secret-value");
    expect(JSON.stringify(result)).not.toContain("secretRef");
  });

  it("escapes inline GraphQL input values", () => {
    expect(
      graphjinInputValue({ roles: [{ name: "admin", match: "role = \"admin\"" }] }),
    ).toBe('{ roles: [{ name: "admin", match: "role = \\"admin\\"" }] }');
  });

  it("hashes proposals independently of object key order", () => {
    expect(
      graphjinConfigPatchHash({ action: "add_role", name: "support" }),
    ).toBe(
      graphjinConfigPatchHash({ name: "support", action: "add_role" }),
    );
  });
});
