import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MetricQuestionInputSchema, createEvalPlan, loadEval } from "../src";

describe("eval config safety", () => {
  it("rejects literal secret-shaped values before schema parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "openneko-eval-secret-"));
    const path = join(root, "config.yaml");
    await writeFile(
      path,
      `schema_version: openneko.eval/v1\nid: bad\ncredential: ${"sk-" + "this-is-a-literal-secret-value"}\n`,
      "utf8",
    );
    await expect(loadEval(path)).rejects.toThrow(/literal secret-shaped value/u);
  });

  it("rejects credentials hidden in generic settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "openneko-eval-credential-"));
    const path = join(root, "config.yaml");
    await writeFile(
      path,
      `schema_version: openneko.eval/v1\nid: bad\nsettings:\n  api_key: ordinary-looking-value\n`,
      "utf8",
    );
    await expect(loadEval(path)).rejects.toThrow(/literal credentials are forbidden/u);
  });
});

describe("execution ordering", () => {
  it("rotates the leading variant across repetitions in a counterbalanced plan", async () => {
    const configPath = fileURLToPath(
      new URL("../../../evals/configs/adventureworks-backend-parity.yaml", import.meta.url),
    );
    const loaded = await loadEval(configPath);
    expect(loaded.pricing).toMatchObject({
      id: "standard-api-global",
      version: "2026.07.09",
    });
    const plan = createEvalPlan(loaded);
    const leading = [1, 2, 3].map(
      (repetition) =>
        plan.slots.find(
          (slot) => slot.caseId === "q01" && slot.repetition === repetition,
        )!.variantId,
    );
    expect(new Set(leading).size).toBe(2);
  });
});

describe("metric case input", () => {
  it("loads AdventureWorks questions without precomputed card metadata", async () => {
    const configPath = fileURLToPath(
      new URL("../../../evals/configs/adventureworks-20q.yaml", import.meta.url),
    );
    const loaded = await loadEval(configPath);
    expect(loaded.cases).toHaveLength(20);
    for (const evalCase of loaded.cases) {
      expect(Object.keys(evalCase.input).sort()).toEqual(["question", "role"]);
      expect(evalCase.input.question).toEqual(expect.any(String));
    }
  });

  it("rejects classifier-derived metadata in a metric case", () => {
    expect(() =>
      MetricQuestionInputSchema.parse({
        role: "CFO",
        question: "How many orders did we receive?",
        why: "Count rows in sales.orders",
      }),
    ).toThrow(/unrecognized key/iu);
  });
});
