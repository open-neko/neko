import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createEvalPlan, loadEval } from "@neko/evals";
import { createOpenNekoWorkDriver } from "../scripts/eval-openneko-work";

describe("OpenNeko work-memory eval adapter", () => {
  it("resolves phase-keyed bundles and scores each phase against its own oracle", async () => {
    const configPath = fileURLToPath(
      new URL(
        "../../../evals/configs/openneko-work-memory-smoke.yaml",
        import.meta.url,
      ),
    );
    const loaded = await loadEval(configPath);
    const plan = createEvalPlan(loaded);
    // Three cases expand to 3 + 2 + 1 phase slots.
    expect(plan.calls).toBe(6);
    const driver = createOpenNekoWorkDriver({ loaded, plan });
    const retrieval = loaded.cases.find(
      (candidate) => candidate.id === "m01-memory-retrieval",
    )!;
    const variant = loaded.config.variants[0]!;

    const oracle = await driver.resolveOracle(retrieval, { loaded, plan });
    expect(Object.keys(oracle as Record<string, unknown>).sort()).toEqual([
      "isolate",
      "search",
      "seed",
    ]);

    const searchOutput = {
      plantedFound: true,
      plantedRankedFirst: true,
      decoyOutranked: true,
      missWeakerThanHit: true,
      archivesEmpty: true,
      usageTouched: true,
    };
    const passing = await driver.score({
      case: retrieval,
      variant,
      oracle,
      execution: { output: searchOutput, measurements: {} },
      phase: "search",
      repetition: 1,
    });
    expect(passing.verdict).toBe("pass");
    // Phase-bound assertions only: the seed/isolate checks must not run
    // against a search-phase output.
    expect(passing.checks).toHaveLength(6);
    expect(passing.coverage.safety).toBe(false);

    const failing = await driver.score({
      case: retrieval,
      variant,
      oracle,
      execution: {
        output: { ...searchOutput, decoyOutranked: false },
        measurements: {},
      },
      phase: "search",
      repetition: 1,
    });
    expect(failing.verdict).toBe("fail");

    const isolate = await driver.score({
      case: retrieval,
      variant,
      oracle,
      execution: {
        output: {
          crossOrgHidden: true,
          archiveAccepted: true,
          archivedExcluded: true,
        },
        measurements: {},
      },
      phase: "isolate",
      repetition: 1,
    });
    expect(isolate.verdict).toBe("pass");
    expect(isolate.coverage.safety).toBe(true);
  });
});
