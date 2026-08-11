import { describe, expect, it } from "vitest";
import {
  createScore,
  summarizeEpisodes,
  type EvalEpisode,
} from "../src";

function episode(input: {
  caseId: string;
  status: EvalEpisode["status"];
  score?: EvalEpisode["score"];
  measurements?: EvalEpisode["measurements"];
}): EvalEpisode {
  return {
    schemaVersion: "openneko.eval.episode/v1",
    runId: "run-test",
    slotKey: `suite/dataset/variant/${input.caseId}/1/initial`,
    caseId: input.caseId,
    caseContentId: `sha256:${"1".repeat(64)}`,
    family: "read",
    productPath: "metric",
    difficulty: "smoke",
    capabilityTags: ["fixture.read"],
    semantics: ["CALC-SCALAR"],
    variantId: "variant",
    datasetId: "dataset",
    repetition: 1,
    phase: "initial",
    attempt: 1,
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:01.000Z",
    status: input.status,
    measurements: input.measurements ?? {},
    observations: [],
    ...(input.score ? { score: input.score } : {}),
    ...(input.status !== "completed"
      ? { errorType: "provider_error", error: "provider unavailable" }
      : {}),
    integrityDigest: `sha256:${"2".repeat(64)}`,
  };
}

describe("eval aggregation", () => {
  it("counts execution failures as failed zero-score tasks", () => {
    const passingScore = createScore({
      scorerId: "fixture",
      scorerVersion: "1.0.0",
      scorerDefinition: { exact: true },
      checks: [
        {
          assertionId: "exact",
          dimension: "ground_truth",
          passed: true,
          gate: true,
        },
      ],
    });
    const summary = summarizeEpisodes([
      episode({ caseId: "pass", status: "completed", score: passingScore }),
      episode({ caseId: "failure", status: "environment_failure" }),
    ]);
    expect(summary).toMatchObject({
      expectedEpisodes: 2,
      scoredEpisodes: 1,
      executionFailures: 1,
      taskCount: 2,
      passedTasks: 1,
      taskPassRate: 0.5,
      macro: { groundTruth: 0.5 },
      micro: { groundTruth: 0.5 },
      byDataset: { dataset: { tasks: 2 } },
      byProductPath: { metric: { tasks: 2 } },
    });
    expect(summary.byFamily.read).toMatchObject({
      tasks: 2,
      passed: 1,
      passRate: 0.5,
    });
  });

  it("aggregates latency, usage, and cost with explicit coverage", () => {
    const summary = summarizeEpisodes([
      episode({
        caseId: "one",
        status: "completed",
        measurements: {
          wallDurationMs: 100,
          totalTokens: 10,
          estimatedCostUsd: 0.01,
          usageCoverage: "complete",
          costCoverage: "complete",
        },
      }),
      episode({
        caseId: "two",
        status: "completed",
        measurements: {
          wallDurationMs: 300,
          usageCoverage: "partial",
          costCoverage: "unavailable",
        },
      }),
    ]);
    expect(summary.measurements).toMatchObject({
      wallDurationMs: {
        count: 2,
        coverage: 1,
        total: 400,
        mean: 200,
        p50: 200,
        p95: 290,
        max: 300,
      },
      totalTokens: { count: 1, coverage: 0.5, total: 10 },
      estimatedCostUsd: { count: 1, coverage: 0.5, total: 0.01 },
      usageCoverage: {
        completeEpisodes: 1,
        partialEpisodes: 1,
        unavailableEpisodes: 0,
        completeRate: 0.5,
        availableRate: 1,
      },
      costCoverage: {
        completeEpisodes: 1,
        partialEpisodes: 0,
        unavailableEpisodes: 1,
        completeRate: 0.5,
        availableRate: 0.5,
      },
    });
  });
});
