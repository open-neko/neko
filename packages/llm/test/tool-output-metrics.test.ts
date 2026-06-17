import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  measureToolResult,
  toolResultToText,
} from "../src/work/tool-output/metrics";

describe("estimateTokens", () => {
  it("approximates ~4 chars per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("toolResultToText", () => {
  it("returns strings unchanged", () => {
    expect(toolResultToText("hello")).toBe("hello");
  });

  it("joins Anthropic/ACP text-block arrays", () => {
    expect(
      toolResultToText([
        { type: "text", text: "foo" },
        { type: "text", text: "bar" },
      ]),
    ).toBe("foobar");
  });

  it("stringifies plain objects", () => {
    expect(toolResultToText({ a: 1 })).toBe('{"a":1}');
  });

  it("empty/nullish → empty string", () => {
    expect(toolResultToText(null)).toBe("");
    expect(toolResultToText(undefined)).toBe("");
  });
});

describe("measureToolResult", () => {
  it("reports real savings on a GraphJin-shaped row array", () => {
    const products = Array.from({ length: 100 }, (_, i) => ({
      productid: i + 1,
      name: `Product ${i + 1}`,
      quantity: i,
      reorderpoint: 25,
    }));
    const metric = measureToolResult({
      tool: "Bash",
      result: JSON.stringify({ data: { products } }),
    });
    expect(metric).not.toBeNull();
    expect(metric!.looksJson).toBe(true);
    expect(metric!.format).toBe("columnar");
    expect(metric!.estTokensSaved).toBeGreaterThan(0);
    expect(metric!.savingsPct).toBeGreaterThan(40);
  });

  it("reports zero savings (and passthrough) on plain-text output", () => {
    const metric = measureToolResult({
      tool: "Bash",
      result: "rows: 3 (4ms)",
    });
    expect(metric).not.toBeNull();
    expect(metric!.looksJson).toBe(false);
    expect(metric!.estTokensSaved).toBe(0);
    expect(metric!.savingsPct).toBe(0);
    expect(metric!.format).toBe("passthrough");
  });

  it("returns null for empty output", () => {
    expect(measureToolResult({ tool: "Bash", result: "" })).toBeNull();
    expect(measureToolResult({ tool: "Bash", result: null })).toBeNull();
  });
});
