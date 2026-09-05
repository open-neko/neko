import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MetricQuestionInputSchema,
  VariantSchema,
  assertionsForPhase,
  createEvalPlan,
  loadEval,
  oracleSpecForPhase,
} from "../src";

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
  it("accepts multiple stable lowercase backend IDs", () => {
    for (const backend of ["scripted-alpha", "scripted-beta"]) {
      expect(
        VariantSchema.parse({
          id: `${backend}-candidate`,
          backend,
          outer_model: { provider: "fixture", model: "deterministic" },
          data_path: "none",
        }).backend,
      ).toBe(backend);
    }
    expect(() =>
      VariantSchema.parse({
        id: "bad-candidate",
        backend: "Scripted Alpha",
        outer_model: { provider: "fixture", model: "deterministic" },
        data_path: "none",
      }),
    ).toThrow(/stable lowercase identifier/u);
  });

  it("rotates the leading variant across repetitions in a counterbalanced plan", async () => {
    const configPath = fileURLToPath(
      new URL("../../../evals/configs/adventureworks-provider-matrix.yaml", import.meta.url),
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

describe("phase-keyed oracle bundles", () => {
  const caseYaml = (oracleBlock: string, assertionPhase = "search") => `schema_version: openneko.eval.case/v1
id: bundle
version: 1.0.0
family: mutation
product_path: work
dataset: fixture
capability_tags: [memory.search]
difficulty: contract
semantics: [WORK-MEMORY-SEARCH]
input: { scenario: bundle }
${oracleBlock}
phases: [seed, search]
allowed_side_effects: [isolated-test-org]
assertions:
  - { id: found, dimension: ground_truth, kind: boolean.path, gate: true, phase: ${assertionPhase}, params: { path: found } }
  - { id: all-phases, dimension: behavior, kind: boolean.path, gate: true, params: { path: ok } }
`;

  async function loadBundleCase(oracleBlock: string, assertionPhase?: string) {
    const root = await mkdtemp(join(tmpdir(), "openneko-eval-bundle-"));
    await writeFile(join(root, "case.yaml"), caseYaml(oracleBlock, assertionPhase), "utf8");
    await writeFile(
      join(root, "dataset.yaml"),
      `schema_version: openneko.eval.dataset/v1
id: fixture
version: 1.0.0
license: test-only
capabilities: [memory.search]
snapshots: [{ id: v1, seed: 1 }]
connection: {}
anchor_policy: { kind: fixed, value: "2026-01-01" }
`,
      "utf8",
    );
    await writeFile(
      join(root, "suite.yaml"),
      `schema_version: openneko.eval.suite/v1
id: fixture
version: 1.0.0
cases: [{ ref: ./case.yaml }]
gates: { require_safety: false }
`,
      "utf8",
    );
    const configPath = join(root, "config.yaml");
    await writeFile(
      configPath,
      `schema_version: openneko.eval/v1
id: fixture
adapter: fixture
suite: { ref: ./suite.yaml }
datasets: [{ ref: ./dataset.yaml, snapshot: v1 }]
defaults:
  repetitions: 1
  timeout: 10s
  execution_order: declared
  concurrency: 1
  cache_state: warm
  content_capture: metadata
  max_attempts: 1
variants:
  - id: deterministic
    backend: hermes
    outer_model: { provider: deterministic, model: no-model-calls }
    data_path: none
artifacts:
  check_in: none
  raw_dir: ${join(root, "raw")}
  state_dir: ${join(root, "state")}
  results_dir: ${join(root, "results")}
`,
      "utf8",
    );
    return loadEval(configPath);
  }

  it("loads a phase-keyed bundle and resolves specs per phase", async () => {
    const loaded = await loadBundleCase(
      `oracles:
  seed: { kind: inline.expected, params: { expected: { ok: true } } }
  search: { kind: inline.expected, params: { expected: { found: true } } }`,
    );
    const evalCase = loaded.cases[0]!;
    expect(oracleSpecForPhase(evalCase, "seed")?.params).toEqual({
      expected: { ok: true },
    });
    expect(oracleSpecForPhase(evalCase, "search")?.params).toEqual({
      expected: { found: true },
    });
    expect(assertionsForPhase(evalCase.assertions, "seed").map((a) => a.id)).toEqual([
      "all-phases",
    ]);
    expect(assertionsForPhase(evalCase.assertions, "search").map((a) => a.id)).toEqual([
      "found",
      "all-phases",
    ]);
    const plan = createEvalPlan(loaded);
    expect(plan.slots.map((slot) => slot.phase)).toEqual(["seed", "search"]);
  });

  it("keeps the legacy single oracle applying to every phase", async () => {
    const loaded = await loadBundleCase(
      `oracle: { kind: inline.expected, params: { expected: { ok: true } } }`,
    );
    const evalCase = loaded.cases[0]!;
    expect(oracleSpecForPhase(evalCase, "seed")?.kind).toBe("inline.expected");
    expect(oracleSpecForPhase(evalCase, "search")?.kind).toBe("inline.expected");
  });

  it("rejects a case declaring both oracle forms", async () => {
    await expect(
      loadBundleCase(
        `oracle: { kind: inline.expected }
oracles:
  seed: { kind: inline.expected }`,
      ),
    ).rejects.toThrow(/exactly one of oracle or oracles/u);
  });

  it("rejects bundle keys and assertion phases outside the case phases", async () => {
    await expect(
      loadBundleCase(
        `oracles:
  teardown: { kind: inline.expected }`,
      ),
    ).rejects.toThrow(/oracle phase teardown is not in phases/u);
    await expect(
      loadBundleCase(
        `oracles:
  seed: { kind: inline.expected }`,
        "missing-phase",
      ),
    ).rejects.toThrow(/assertion phase missing-phase is not in phases/u);
  });
});
