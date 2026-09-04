import { describe, expect, it } from "vitest";
import { planDocumentChunks } from "../src/library/chunk";
import { sliceMarkdownSections } from "../src/library/extract";

describe("planDocumentChunks", () => {
  it("returns a single unframed chunk when the document fits the budget", () => {
    const text = "# Small\n\nShort body.";
    expect(planDocumentChunks(text, sliceMarkdownSections(text), 1000)).toEqual([
      { index: 1, total: 1, headingPath: [], text },
    ]);
  });

  it("packs consecutive sections into chunks under the budget", () => {
    const text = [
      "# Alpha",
      "a".repeat(60),
      "# Beta",
      "b".repeat(60),
      "# Gamma",
      "c".repeat(60),
    ].join("\n");
    const chunks = planDocumentChunks(text, sliceMarkdownSections(text), 80);
    // Each section is ~67 chars, so no two fit together under 80 → 3 chunks.
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(chunks.every((c) => c.total === 3)).toBe(true);
    expect(chunks[0].headingPath).toEqual(["Alpha"]);
    expect(chunks[2].headingPath).toEqual(["Gamma"]);
    // No content is lost or reordered.
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("hard-splits a single section larger than the budget", () => {
    const text = "# Big\n" + "x".repeat(500);
    const chunks = planDocumentChunks(text, sliceMarkdownSections(text), 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true);
    expect(chunks[0].headingPath).toEqual(["Big"]);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
  });

  it("windows a document with no heading structure", () => {
    const text = "z".repeat(250);
    const chunks = planDocumentChunks(text, [], 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks.every((c) => c.headingPath.length === 0)).toBe(true);
  });
});
