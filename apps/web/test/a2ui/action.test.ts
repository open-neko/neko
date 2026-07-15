import { describe, expect, it } from "vitest";
import { buildActionFollowUp } from "@/a2ui/action";

describe("buildActionFollowUp", () => {
  it("keeps legacy prompt-only actions compact", () => {
    expect(buildActionFollowUp({ prompt: "Show the trend." })).toBe("Show the trend.");
  });

  it("makes submitted configuration visible in the next operator turn", () => {
    const result = buildActionFollowUp({
      prompt: "Review and file a source proposal.",
      values: { name: "warehouse", port: 5432, secretRef: "warehouse-password" },
    });
    expect(result).toContain("Review and file a source proposal.");
    expect(result).toContain('"name": "warehouse"');
    expect(result).toContain('"secretRef": "warehouse-password"');
  });

  it("requires an explicit action prompt", () => {
    expect(buildActionFollowUp({ values: { name: "warehouse" } })).toBeNull();
  });
});
