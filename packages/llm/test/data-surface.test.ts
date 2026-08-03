import { describe, expect, it } from "vitest";
import { parseAppWorkContext } from "../src/work/data-surface";

describe("parseAppWorkContext", () => {
  it("accepts the stable app chat ownership marker", () => {
    expect(parseAppWorkContext({ appId: "crm", appLabel: "CRM" })).toEqual({
      appId: "crm",
      appLabel: "CRM",
    });
  });

  it("rejects malformed ownership markers", () => {
    expect(parseAppWorkContext({ appId: "", appLabel: "CRM" })).toBeNull();
    expect(parseAppWorkContext({ appId: "crm" })).toBeNull();
    expect(parseAppWorkContext("crm")).toBeNull();
  });
});
