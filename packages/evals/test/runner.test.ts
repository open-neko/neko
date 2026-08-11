import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createEvalPlan,
  loadEval,
  rescoreEvaluation,
  runEvaluation,
  verifyResult,
} from "../src";
import { createFixtureDriver } from "./fixtures/fixture-driver";
import { runEvalCli } from "../src/cli";

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
}

async function fixture(
  options: {
    family?: "read" | "mutation";
    maxCostUsd?: number;
    minTokenUsageCoverage?: number;
  } = {},
): Promise<{
  root: string;
  configPath: string;
  stateRoot: string;
  resultsRoot: string;
  callLog: string;
  resetLog: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "openneko-eval-test-"));
  const cases = ["one", "two", "three"];
  await put(
    join(root, "dataset.yaml"),
    `schema_version: openneko.eval.dataset/v1
id: fixture
version: 1.0.0
license: test-only
capabilities: [fixture.read]
snapshots: [{ id: fixed, seed: 1 }]
connection: {}
anchor_policy: { kind: fixed, value: "2026-08-10" }
`,
  );
  for (const [index, id] of cases.entries()) {
    await put(
      join(root, "cases", `${id}.yaml`),
      `schema_version: openneko.eval.case/v1
id: ${id}
version: 1.0.0
family: ${options.family ?? "read"}
product_path: metric
dataset: fixture
capability_tags: [fixture.read]
difficulty: smoke
semantics: [RUNTIME-RESUME]
input: { expected: ${index + 1} }
oracle: { kind: fixture }
assertions:
  - { id: exact, dimension: ground_truth, kind: fixture.exact, gate: true }
`,
    );
  }
  await put(
    join(root, "suite.yaml"),
    `schema_version: openneko.eval.suite/v1
id: fixture
version: 1.0.0
cases:
${cases.map((id) => `  - { ref: ./cases/${id}.yaml }`).join("\n")}
${
  options.minTokenUsageCoverage === undefined
    ? ""
    : `gates:\n  min_token_usage_coverage: ${options.minTokenUsageCoverage}\n  require_safety: false\n`
}
`,
  );
  const stateRoot = join(root, "state");
  const resultsRoot = join(root, "results");
  const configPath = join(root, "config.yaml");
  await put(
    configPath,
    `schema_version: openneko.eval/v1
id: fixture
adapter: fixture
suite: { ref: ./suite.yaml }
datasets: [{ ref: ./dataset.yaml, snapshot: fixed }]
defaults:
  repetitions: 1
  timeout: 10s
  execution_order: declared
  concurrency: 1
  cache_state: warm
  content_capture: metadata
  max_attempts: 2
variants:
  - id: hermes-fixture
    backend: hermes
    outer_model: { provider: fixture, model: deterministic }
    data_path: none
${
  options.maxCostUsd === undefined
    ? ""
    : `budgets:\n  max_estimated_cost_usd: ${options.maxCostUsd}\n`
}artifacts:
  check_in: none
  raw_dir: ${join(root, "raw")}
  state_dir: ${stateRoot}
  results_dir: ${resultsRoot}
`,
  );
  return {
    root,
    configPath,
    stateRoot,
    resultsRoot,
    callLog: join(root, "calls.log"),
    resetLog: join(root, "resets.log"),
  };
}

describe("durable eval execution", () => {
  it("resumes after a hard process exit and reuses every verified episode", async () => {
    const paths = await fixture();
    const childPath = fileURLToPath(new URL("./fixtures/crash-runner.ts", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        childPath,
        paths.configPath,
        paths.stateRoot,
        paths.resultsRoot,
        paths.callLog,
        process.cwd(),
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(91);

    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    const counters = { execute: 0, score: 0 };
    const result = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog, counters }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      promote: true,
    });

    expect(result.resumed).toBe(true);
    expect(result.reusedEpisodes).toBe(1);
    expect(counters.execute).toBe(2);
    expect((await readFile(paths.callLog, "utf8")).trim().split("\n")).toHaveLength(4);
    expect(result.manifest.status).toBe("complete");
    expect(result.manifest.completedSlotKeys).toHaveLength(3);
    await expect(verifyResult(result.resultDir!)).resolves.toMatchObject({
      ok: true,
      episodes: 3,
    });
    const checkedIn = await readFile(join(result.resultDir!, "results.jsonl"), "utf8");
    expect(checkedIn).not.toContain('"output"');
    expect(checkedIn).not.toContain('"observations"');
    expect(checkedIn).not.toContain('"actual"');
    const summary = JSON.parse(
      await readFile(join(result.resultDir!, "summary.json"), "utf8"),
    ) as {
      byDifficulty: Record<string, { tasks: number }>;
      byCapability: Record<string, { tasks: number }>;
    };
    expect(summary.byDifficulty.smoke?.tasks).toBe(3);
    expect(summary.byCapability["fixture.read"]?.tasks).toBe(3);
    const manifestPath = join(result.resultDir!, "manifest.json");
    const artifactManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      effectiveConfig: { variants: Array<Record<string, unknown>> };
    };
    artifactManifest.effectiveConfig.variants[0]!.settings = {
      api_key: "ordinary-looking-literal",
    };
    await writeFile(manifestPath, JSON.stringify(artifactManifest), "utf8");
    await expect(verifyResult(result.resultDir!)).rejects.toThrow(
      /literal credential/u,
    );
  });

  it("re-scores stored output without invoking the harness", async () => {
    const paths = await fixture();
    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    const initial = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      promote: false,
    });
    const counters = { execute: 0, score: 0 };
    const rescored = await rescoreEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog, counters }),
      stateRoot: paths.stateRoot,
      runId: initial.runId,
    });
    expect(counters.execute).toBe(0);
    expect(counters.score).toBe(3);
    expect(rescored.episodes.every((episode) => episode.score?.verdict === "pass")).toBe(true);
    expect(await readFile(rescored.path, "utf8")).toContain("openneko.eval.rescore/v1");
  });

  it("requires token coverage when configured without requiring dollar cost", async () => {
    const missingPaths = await fixture({ minTokenUsageCoverage: 1 });
    const missingLoaded = await loadEval(missingPaths.configPath);
    const missingPlan = createEvalPlan(missingLoaded);
    const missing = await runEvaluation({
      loaded: missingLoaded,
      plan: missingPlan,
      driver: createFixtureDriver({
        loaded: missingLoaded,
        plan: missingPlan,
        callLog: missingPaths.callLog,
      }),
      cwd: process.cwd(),
      stateRoot: missingPaths.stateRoot,
      resultsRoot: missingPaths.resultsRoot,
      promote: true,
    });
    expect(missing.gatesPassed).toBe(false);
    await expect(verifyResult(missing.resultDir!)).resolves.toMatchObject({
      gatesPassed: false,
    });

    const tokenPaths = await fixture({ minTokenUsageCoverage: 1 });
    const tokenLoaded = await loadEval(tokenPaths.configPath);
    const tokenPlan = createEvalPlan(tokenLoaded);
    const withTokens = await runEvaluation({
      loaded: tokenLoaded,
      plan: tokenPlan,
      driver: createFixtureDriver({
        loaded: tokenLoaded,
        plan: tokenPlan,
        callLog: tokenPaths.callLog,
        totalTokens: 42,
      }),
      cwd: process.cwd(),
      stateRoot: tokenPaths.stateRoot,
      resultsRoot: tokenPaths.resultsRoot,
      promote: true,
    });
    expect(withTokens.gatesPassed).toBe(true);
    await expect(verifyResult(withTokens.resultDir!)).resolves.toMatchObject({
      gatesPassed: true,
    });
    const markdown = await readFile(join(withTokens.resultDir!, "summary.md"), "utf8");
    expect(markdown).toContain("Estimated / billed cost: unavailable / unavailable");
  });

  it("closes adapter resources when setup or rescoring fails", async () => {
    const paths = await fixture();
    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    let setupCloses = 0;
    const setupDriver = createFixtureDriver({ loaded, plan, callLog: paths.callLog });
    setupDriver.preflight = async () => {
      throw new Error("preflight failed");
    };
    setupDriver.close = async () => {
      setupCloses += 1;
    };
    await expect(
      runEvaluation({
        loaded,
        plan,
        driver: setupDriver,
        cwd: process.cwd(),
        stateRoot: paths.stateRoot,
        resultsRoot: paths.resultsRoot,
        promote: false,
      }),
    ).rejects.toThrow("preflight failed");
    expect(setupCloses).toBe(1);

    const initial = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      promote: false,
    });
    let rescoreCloses = 0;
    const rescoreDriver = createFixtureDriver({ loaded, plan, callLog: paths.callLog });
    rescoreDriver.score = () => {
      throw new Error("scoring failed");
    };
    rescoreDriver.close = async () => {
      rescoreCloses += 1;
    };
    await expect(
      rescoreEvaluation({
        loaded,
        plan,
        driver: rescoreDriver,
        stateRoot: paths.stateRoot,
        runId: initial.runId,
      }),
    ).rejects.toThrow("scoring failed");
    expect(rescoreCloses).toBe(1);
  });

  it("resets and replays an ambiguous mutation slot after a hard exit", async () => {
    const paths = await fixture({ family: "mutation" });
    const childPath = fileURLToPath(new URL("./fixtures/crash-runner.ts", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        childPath,
        paths.configPath,
        paths.stateRoot,
        paths.resultsRoot,
        paths.callLog,
        process.cwd(),
        paths.resetLog,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(91);

    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    const result = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({
        loaded,
        plan,
        callLog: paths.callLog,
        resetLog: paths.resetLog,
      }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      promote: false,
    });
    const resets = (await readFile(paths.resetLog, "utf8")).trim().split("\n");
    const interruptedSlot = (await readFile(paths.callLog, "utf8")).trim().split("\n")[1]!;
    expect(result.resumed).toBe(true);
    expect(resets.filter((slot) => slot === interruptedSlot)).toHaveLength(3);
    expect(resets).toHaveLength(7);
  });

  it("stops before the next slot when the configured cost budget is exhausted", async () => {
    const paths = await fixture({ maxCostUsd: 1 });
    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    await expect(
      runEvaluation({
        loaded,
        plan,
        driver: createFixtureDriver({
          loaded,
          plan,
          callLog: paths.callLog,
          estimatedCostUsd: 1,
        }),
        cwd: process.cwd(),
        stateRoot: paths.stateRoot,
        resultsRoot: paths.resultsRoot,
        promote: false,
      }),
    ).rejects.toThrow(/cost budget .* exhausted/u);
    expect((await readFile(paths.callLog, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("compares compatible cohorts with paired task deltas", async () => {
    const paths = await fixture();
    const loaded = await loadEval(paths.configPath);
    const plan = createEvalPlan(loaded);
    const first = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      promote: true,
    });
    const second = await runEvaluation({
      loaded,
      plan,
      driver: createFixtureDriver({ loaded, plan, callLog: paths.callLog }),
      cwd: process.cwd(),
      stateRoot: paths.stateRoot,
      resultsRoot: paths.resultsRoot,
      restart: true,
      promote: true,
    });
    let output = "";
    const code = await runEvalCli(
      ["compare", "--result", second.resultDir!, "--baseline", first.resultDir!],
      { adapters: {}, stdout: { write: (value) => (output += String(value)) } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      paired: { tasks: 3, meanGroundTruthDelta: 0 },
    });
  });
});
