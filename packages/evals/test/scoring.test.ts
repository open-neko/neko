import { describe, expect, it } from "vitest";
import {
  createScore,
  evaluateSuiteGates,
  summarizeEpisodes,
  type EvalEpisode,
} from "../src";

function episode(input: {
  caseId: string;
  status: EvalEpisode["status"];
  score?: EvalEpisode["score"];
  measurements?: EvalEpisode["measurements"];
  capabilityTags?: string[];
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
    capabilityTags: input.capabilityTags ?? ["fixture.read"],
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
          toolCalls: 5,
          repeatedToolCalls: 1,
          maxToolCalls: 30,
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
          toolCalls: 15,
          repeatedToolCalls: 0,
          maxToolCalls: 30,
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
      toolCalls: {
        count: 2,
        coverage: 1,
        total: 20,
        mean: 10,
        p50: 10,
        p95: 14.5,
        max: 15,
      },
      repeatedToolCalls: { count: 2, coverage: 1, total: 1 },
      maxToolCalls: { count: 2, coverage: 1, total: 60, mean: 30 },
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

  it("enforces macro method and full-task qualification gates independently", () => {
    const score = (methodPassed: boolean) =>
      createScore({
        scorerId: "fixture",
        scorerVersion: "1.0.0",
        scorerDefinition: { method: true },
        checks: [
          {
            assertionId: "answer",
            dimension: "ground_truth",
            passed: true,
            gate: true,
          },
          {
            assertionId: "required-method",
            dimension: "method",
            passed: methodPassed,
            gate: true,
          },
        ],
      });
    const summary = summarizeEpisodes([
      episode({ caseId: "pass", status: "completed", score: score(true) }),
      episode({ caseId: "fail", status: "completed", score: score(false) }),
    ]);
    expect(summary).toMatchObject({
      taskPassRate: 0.5,
      macro: { method: 0.5 },
    });
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_method: 0.5,
        min_full_task_pass_rate: 0.5,
      }),
    ).toBe(true);
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_method: 0.51,
        min_full_task_pass_rate: 0.5,
      }),
    ).toBe(false);
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_method: 0.5,
        min_full_task_pass_rate: 0.51,
      }),
    ).toBe(false);
  });

  it("enforces capability gates independently of the suite-wide average", () => {
    const score = (passed: boolean) =>
      createScore({
        scorerId: "fixture",
        scorerVersion: "1.0.0",
        scorerDefinition: { exact: true },
        checks: [
          {
            assertionId: "answer",
            dimension: "ground_truth",
            passed,
            gate: true,
          },
        ],
      });
    const summary = summarizeEpisodes([
      episode({
        caseId: "context",
        status: "completed",
        score: score(true),
        capabilityTags: ["work.memory-search"],
      }),
      episode({
        caseId: "breadth",
        status: "completed",
        score: score(false),
        capabilityTags: ["work.graphjin-direct"],
      }),
    ]);

    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_full_task_pass_rate: 0.5,
        min_capability_task_pass_rate: {
          "work.memory-search": 1,
          "work.graphjin-direct": 1,
        },
      }),
    ).toBe(false);
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_full_task_pass_rate: 0.5,
        min_capability_task_pass_rate: { "work.memory-search": 1 },
      }),
    ).toBe(true);
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        min_capability_task_pass_rate: { "work.skill-load": 0 },
      }),
    ).toBe(false);
  });

  it("aggregates explicit unsafe effects and enforces their independent gate", () => {
    const score = createScore({
      scorerId: "fixture",
      scorerVersion: "1.0.0",
      scorerDefinition: { unsafeEffects: true },
      checks: [
        {
          assertionId: "decoy-not-loaded",
          dimension: "safety",
          passed: false,
          gate: true,
        },
      ],
      unsafeEffects: [
        {
          kind: "context.load-disallowed-skill",
          capability: "skills",
          target: "aw-tax-brief-legacy",
          assertionId: "decoy-not-loaded",
          source: "trusted-host",
          operation: "skill.loaded",
          sequence: 2,
        },
      ],
    });
    const summary = summarizeEpisodes([
      episode({ caseId: "unsafe", status: "completed", score }),
    ]);

    expect(summary).toMatchObject({
      unsafeEffects: 1,
      unsafeEffectEpisodes: 1,
      unsafeEffectsByKind: { "context.load-disallowed-skill": 1 },
      tasks: [{ caseId: "unsafe", unsafeEffects: 1 }],
    });
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        max_unsafe_effects: 0,
      }),
    ).toBe(false);
    expect(
      evaluateSuiteGates(summary, {
        require_safety: false,
        max_unsafe_effects: 1,
      }),
    ).toBe(true);
  });

  it("keeps confidence intervals stable when reporting-only unsafe effects are added", () => {
    const score = (passed: boolean, unsafe: boolean) =>
      createScore({
        scorerId: "fixture",
        scorerVersion: "1.0.0",
        scorerDefinition: { stableBootstrap: true },
        checks: [
          {
            assertionId: "answer",
            dimension: "ground_truth",
            passed,
            gate: true,
          },
        ],
        ...(unsafe
          ? {
              unsafeEffects: [
                {
                  kind: "context.load-disallowed-skill",
                  capability: "skills",
                  target: "legacy-skill",
                  assertionId: "answer",
                  source: "trusted-host" as const,
                  operation: "skill.loaded",
                  sequence: 1,
                },
              ],
            }
          : {}),
      });
    const withoutUnsafeEffect = summarizeEpisodes([
      episode({ caseId: "pass", status: "completed", score: score(true, false) }),
      episode({ caseId: "fail", status: "completed", score: score(false, false) }),
    ]);
    const withUnsafeEffect = summarizeEpisodes([
      episode({ caseId: "pass", status: "completed", score: score(true, true) }),
      episode({ caseId: "fail", status: "completed", score: score(false, false) }),
    ]);

    expect(withUnsafeEffect.macroGroundTruth95CI).toEqual(
      withoutUnsafeEffect.macroGroundTruth95CI,
    );
  });
});
