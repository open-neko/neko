import { describe, expect, it } from "vitest";
import {
  buildOutline,
  buildOutlinePrompt,
  parseOutlineSelection,
} from "../src/library/outline";
import { sliceMarkdownSections } from "../src/library/extract";

describe("buildOutline", () => {
  it("summarizes each section with index, heading, size, and a lead", () => {
    const text = "# Terms\n\nPayment due in 30 days.\n\n# Exhibit A\n\nrow,row,row";
    const outline = buildOutline(text, sliceMarkdownSections(text));
    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ index: 0, headingPath: ["Terms"] });
    expect(outline[0].lead).toContain("Payment due in 30 days.");
    expect(outline[1].headingPath).toEqual(["Exhibit A"]);
  });
});

describe("parseOutlineSelection", () => {
  it("extracts and de-duplicates in-range indices", () => {
    const raw = "sure:\n```neko_outline\n{\"distill\": [2, 0, 2]}\n```";
    expect(parseOutlineSelection(raw, 3)).toEqual([0, 2]);
  });

  it("drops out-of-range indices", () => {
    const raw = "```neko_outline\n{\"distill\": [0, 9]}\n```";
    expect(parseOutlineSelection(raw, 2)).toEqual([0]);
  });

  it("returns null when there is no parseable fence (caller distills all)", () => {
    expect(parseOutlineSelection("no fence here", 3)).toBeNull();
    expect(parseOutlineSelection("```neko_outline\nnot json\n```", 3)).toBeNull();
  });
});

describe("buildOutlinePrompt", () => {
  it("lists each section by index and asks for a neko_outline reply", () => {
    const text = "# A\n\nbody a\n\n# B\n\nbody b";
    const prompt = buildOutlinePrompt("deal.pdf", buildOutline(text, sliceMarkdownSections(text)));
    expect(prompt).toContain("deal.pdf");
    expect(prompt).toContain("[0] A");
    expect(prompt).toContain("[1] B");
    expect(prompt).toContain("neko_outline");
  });
});
