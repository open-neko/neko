import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  isTerminalMagentoBulkStatus,
  magentoGraphjinMutationField,
} from "../src/packs/magento-v2-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeSource = resolve(here, "../src/packs/magento-v2-runtime.ts");
const serviceSource = resolve(here, "../src/packs/service.ts");

describe("Magento V2 GraphJin mutation aliases", () => {
  it("calls the expose_as field rather than the namespaced artifact identity", () => {
    expect(
      magentoGraphjinMutationField("magento_operator_v2_magento_update_product"),
    ).toBe("magento_update_product");
  });

  it("rejects roots that do not carry the reviewed V2 namespace", () => {
    expect(() => magentoGraphjinMutationField("magento_update_product")).toThrow(
      "invalid Magento V2 mutation root",
    );
  });

  it("waits while Magento reports an async operation as open", () => {
    expect(isTerminalMagentoBulkStatus(4)).toBe(false);
    expect([1, 2, 3, 5].every(isTerminalMagentoBulkStatus)).toBe(true);
  });

  it("keeps numeric risk labels out of operator errors, receipts, and admin responses", async () => {
    const source = [
      await readFile(runtimeSource, "utf8"),
      await readFile(serviceSource, "utf8"),
    ].join("\n");

    expect(source).not.toMatch(/\bclass\s*[012]\b/i);
    expect(source).toContain("complete it in Magento Admin");
    expect(source).toContain("requires approval from a human administrator");
    expect(source).toContain("executionMode");
    expect(source).toContain("automationEligible");
    expect(source).toContain("handoffOnly");
  });
});
