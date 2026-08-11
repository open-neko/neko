import type { NormalizedUsage } from "@neko/telemetry";
import type { PricingCatalog } from "./schemas";

export type UsageCostEstimate = {
  estimatedCostUsd?: number;
  currency?: "USD";
  pricingCatalogVersion?: string;
  coverage: "complete" | "partial" | "unavailable";
  missingReasons?: string[];
};

/** Estimate token cost from an explicitly selected, versioned catalog. */
export function estimateUsageCost(input: {
  usage: NormalizedUsage | undefined;
  provider: string;
  model: string;
  catalog: PricingCatalog | undefined;
}): UsageCostEstimate {
  if (!input.usage) {
    return {
      coverage: "unavailable",
      missingReasons: ["model scope returned no token usage"],
    };
  }
  if (!input.catalog) {
    return {
      coverage: "unavailable",
      missingReasons: ["no pricing catalog selected"],
    };
  }
  const entry = input.catalog.entries.find(
    (candidate) =>
      candidate.provider === input.provider && candidate.model === input.model,
  );
  if (!entry) {
    return {
      coverage: "unavailable",
      missingReasons: [
        `pricing catalog ${input.catalog.id}@${input.catalog.version} has no ${input.provider}/${input.model} entry`,
      ],
    };
  }

  const usage = input.usage;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const missing: string[] =
    usage.coverage === "complete"
      ? []
      : usage.missingReasons?.length
        ? [...usage.missingReasons]
        : [`token usage coverage is ${usage.coverage}`];
  let pricedTokens = 0;
  let estimatedCostUsd = 0;

  if (usage.inputTokens === undefined) {
    missing.push("input token count unavailable");
  } else {
    const uncachedInput = Math.max(
      0,
      usage.inputTokens - cacheRead - cacheWrite,
    );
    estimatedCostUsd +=
      (uncachedInput * entry.input_usd_per_million_tokens) / 1_000_000;
    pricedTokens += uncachedInput;
  }
  if (usage.outputTokens === undefined) {
    missing.push("output token count unavailable");
  } else {
    estimatedCostUsd +=
      (usage.outputTokens * entry.output_usd_per_million_tokens) / 1_000_000;
    pricedTokens += usage.outputTokens;
  }
  if (cacheRead > 0) {
    if (entry.cache_read_usd_per_million_tokens === undefined) {
      missing.push("cache-read price unavailable");
    } else {
      estimatedCostUsd +=
        (cacheRead * entry.cache_read_usd_per_million_tokens) / 1_000_000;
      pricedTokens += cacheRead;
    }
  }
  if (cacheWrite > 0) {
    if (entry.cache_write_usd_per_million_tokens === undefined) {
      missing.push("cache-write price unavailable");
    } else {
      estimatedCostUsd +=
        (cacheWrite * entry.cache_write_usd_per_million_tokens) / 1_000_000;
      pricedTokens += cacheWrite;
    }
  }

  const hasCompleteTokenPair =
    usage.inputTokens !== undefined && usage.outputTokens !== undefined;
  const coverage =
    usage.coverage === "complete" && missing.length === 0 && hasCompleteTokenPair
      ? "complete"
      : pricedTokens > 0
        ? "partial"
        : "unavailable";
  return {
    ...(pricedTokens > 0 || coverage === "complete" ? { estimatedCostUsd } : {}),
    currency: "USD",
    pricingCatalogVersion: input.catalog.version,
    coverage,
    ...(missing.length > 0 ? { missingReasons: missing } : {}),
  };
}
