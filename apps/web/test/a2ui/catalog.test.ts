import { describe, expect, it } from "vitest";
import { CATALOG_ID, ComponentTypes } from "@/a2ui/catalog";

describe("A2UI catalog", () => {
  it("CATALOG_ID is a non-empty URN", () => {
    expect(CATALOG_ID.length).toBeGreaterThan(0);
    expect(CATALOG_ID).toMatch(/^urn:/);
  });

  it("ComponentTypes keys equal their string values (no typos)", () => {
    for (const [key, value] of Object.entries(ComponentTypes)) {
      expect(value).toBe(key);
    }
  });

  it("includes the components the answer surface can render", () => {
    expect(ComponentTypes).toMatchObject({
      Answer: "Answer",
      MetricCard: "MetricCard",
      Confirmation: "Confirmation",
      Markdown: "Markdown",
      Table: "Table",
      Section: "Section",
      Callout: "Callout",
      Choice: "Choice",
      Divider: "Divider",
    });
  });

  it("keeps Briefing/BriefingCard as dashboard + back-compat aliases", () => {
    expect(ComponentTypes).toMatchObject({
      Briefing: "Briefing",
      BriefingCard: "BriefingCard",
    });
  });
});
