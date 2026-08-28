import { describe, expect, it } from "vitest";

import {
  isTerminalMagentoBulkStatus,
  magentoGraphjinMutationField,
} from "../src/packs/magento-v2-runtime.js";

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
});
