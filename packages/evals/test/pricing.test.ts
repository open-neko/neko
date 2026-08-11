import { describe, expect, it } from "vitest";
import { estimateUsageCost, type PricingCatalog } from "../src";

const catalog: PricingCatalog = {
  schema_version: "openneko.eval.pricing/v1",
  id: "fixture",
  version: "2026.07.09",
  currency: "USD",
  effective_date: "2026-07-09",
  sources: ["https://example.com/pricing"],
  entries: [
    {
      provider: "google-gemini",
      model: "gemini-3.6-flash",
      input_usd_per_million_tokens: 1.5,
      output_usd_per_million_tokens: 7.5,
      cache_read_usd_per_million_tokens: 0.15,
    },
  ],
};

describe("versioned usage pricing", () => {
  it("prices uncached input, cache reads, and output separately", () => {
    const result = estimateUsageCost({
      catalog,
      provider: "google-gemini",
      model: "gemini-3.6-flash",
      usage: {
        inputTokens: 213_356,
        outputTokens: 1_035,
        cacheReadTokens: 147_000,
        totalTokens: 214_391,
        coverage: "complete",
      },
    });
    expect(result).toMatchObject({
      coverage: "complete",
      currency: "USD",
      pricingCatalogVersion: "2026.07.09",
    });
    expect(result.estimatedCostUsd).toBeCloseTo(0.129_346_5, 10);
  });

  it("leaves unknown local models unpriced without affecting token usage", () => {
    const result = estimateUsageCost({
      catalog,
      provider: "ollama",
      model: "gemma4:latest",
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
        coverage: "complete",
      },
    });
    expect(result.coverage).toBe("unavailable");
    expect(result.estimatedCostUsd).toBeUndefined();
  });
});
