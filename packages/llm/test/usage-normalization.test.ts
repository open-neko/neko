import { describe, expect, it } from "vitest";
import { normalizeClaudeAgentUsage } from "../src/agent-backends/claude-agent";
import { normalizeHermesUsage } from "../src/agent-backends/hermes";
import {
  combineAgentTokenUsage,
  normalizeAxProgramUsage,
  normalizeGraphjinAgentUsage,
} from "../src/usage-normalization";

describe("provider usage normalization", () => {
  it("sums every Ax classifier call and retry", () => {
    const usage = normalizeAxProgramUsage([
      {
        ai: "google-gemini",
        model: "gemini-test",
        tokens: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      },
      {
        ai: "google-gemini",
        model: "gemini-test",
        tokens: {
          promptTokens: 12,
          completionTokens: 3,
          totalTokens: 15,
          thoughtsTokens: 2,
        },
      },
    ]);
    expect(usage).toEqual({
      inputTokens: 22,
      outputTokens: 7,
      reasoningTokens: 2,
      totalTokens: 29,
      coverage: "complete",
    });
  });

  it("combines classifier and agent tokens without treating a missing scope as zero", () => {
    expect(
      combineAgentTokenUsage(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, coverage: "complete" },
        {
          coverage: "unavailable",
          missingReasons: ["metric-agent usage unavailable"],
        },
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      coverage: "partial",
      missingReasons: ["metric-agent usage unavailable"],
    });
  });

  it("normalizes Hermes ACP camelCase and snake_case usage", () => {
    expect(
      normalizeHermesUsage({
        input_tokens: 10,
        outputTokens: 4,
        cached_read_tokens: 3,
        thought_tokens: 2,
        cost_usd: 0.125,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      reasoningTokens: 2,
      totalTokens: 14,
      billedCostUsd: 0.125,
      currency: "USD",
      coverage: "complete",
    });
  });

  it("includes Claude cache tokens in normalized input and provider cost", () => {
    expect(
      normalizeClaudeAgentUsage({
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 5,
        },
        total_cost_usd: 0.25,
      }),
    ).toEqual({
      inputTokens: 45,
      outputTokens: 4,
      cacheReadTokens: 30,
      cacheWriteTokens: 5,
      totalTokens: 49,
      billedCostUsd: 0.25,
      currency: "USD",
      coverage: "complete",
    });
  });

  it("finds inner-model usage inside an MCP-encoded GraphJin response", () => {
    expect(
      normalizeGraphjinAgentUsage({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              agentStatus: { provider: "gemini", model: "gemini-3.6-flash" },
              response: {
                usage: {
                  prompt_tokens: 20,
                  completion_tokens: 6,
                  total_tokens: 26,
                },
              },
            }),
          },
        ],
      }),
    ).toEqual({
      provider: "gemini",
      model: "gemini-3.6-flash",
      usage: {
        inputTokens: 20,
        outputTokens: 6,
        totalTokens: 26,
        coverage: "complete",
      },
    });
  });
});
