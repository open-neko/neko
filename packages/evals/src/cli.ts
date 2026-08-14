import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contentDigest } from "./canonical";
import { loadEval, type LoadedEval } from "./load";
import { createEvalPlan, type EvalPlan } from "./plan";
import { renderStoredReport, verifyResult } from "./report";
import {
  rescoreEvaluation,
  runEvaluation,
  type EvalDriver,
} from "./runner";

export type EvalDriverFactory = (context: {
  loaded: LoadedEval;
  plan: EvalPlan;
}) => Promise<EvalDriver> | EvalDriver;

export type EvalCliOptions = {
  cwd?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  adapters: Readonly<Record<string, EvalDriverFactory>>;
};

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function requireFlag(args: readonly string[], name: string): string {
  const value = flag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function usage(): string {
  return `OpenNeko harness eval\n\n` +
    `Commands:\n` +
    `  validate --config <path>\n` +
    `  plan --config <path> [--json]\n` +
    `  oracles --config <path> [--json] [--out <path>]\n` +
    `  run --config <path> [--resume <run-id> | --restart] [--promote | --no-promote]\n` +
    `  resume --config <path> --run <run-id>\n` +
    `  rescore --config <path> --run <run-id>\n` +
    `  verify --result <directory>\n` +
    `  report --result <directory>\n` +
    `  compare --result <directory> --baseline <directory>\n`;
}

async function loadContext(args: readonly string[], cwd: string): Promise<{
  loaded: LoadedEval;
  plan: EvalPlan;
}> {
  const loaded = await loadEval(resolve(cwd, requireFlag(args, "--config")));
  return { loaded, plan: createEvalPlan(loaded) };
}

function planDocument(loaded: LoadedEval, plan: EvalPlan): unknown {
  const derivedSemantics = loaded.config.variants.flatMap((variant) => {
    if (variant.data_path === "graphjin-direct") return ["DATA-DIRECT"];
    if (variant.data_path === "graphjin-agent") return ["DATA-DELEGATED"];
    if (variant.data_path === "planner-host-execute") {
      return ["DATA-PLANNER-EXECUTE"];
    }
    return [];
  });
  const coveredSemantics = [
    ...new Set([
      ...loaded.cases.flatMap((evalCase) => evalCase.semantics),
      ...derivedSemantics,
    ]),
  ].sort();
  const semanticCoverage = loaded.semantics
    ? {
        registryEntries: loaded.semantics.entries.length,
        covered: coveredSemantics,
        coveredCount: coveredSemantics.length,
        requiredEval: loaded.semantics.entries
          .filter((entry) => entry.disposition === "eval")
          .map((entry) => entry.id)
          .sort(),
        missingRequiredEval: loaded.semantics.entries
          .filter(
            (entry) =>
              entry.disposition === "eval" &&
              !coveredSemantics.includes(entry.id),
          )
          .map((entry) => entry.id)
          .sort(),
        dispositionCounts: Object.fromEntries(
          ["declared", "eval", "non-eval"].map((disposition) => [
            disposition,
            loaded.semantics!.entries.filter(
              (entry) => entry.disposition === disposition,
            ).length,
          ]),
        ),
      }
    : undefined;
  return {
    schemaVersion: plan.schemaVersion,
    configId: plan.configId,
    suiteId: plan.suiteId,
    adapter: plan.adapter,
    datasets: [...loaded.datasets.values()].map((dataset) => ({
      id: dataset.id,
      version: dataset.version,
      capabilities: dataset.capabilities,
    })),
    variants: loaded.config.variants.map((variant) => ({
      id: variant.id,
      backend: variant.backend,
      provider: variant.outer_model.provider,
      model: variant.outer_model.model,
      dataPath: variant.data_path,
      innerProvider: variant.inner_model?.provider,
      innerModel: variant.inner_model?.model,
    })),
    selectedCases: loaded.cases.map((evalCase) => evalCase.id),
    repetitions: plan.repetitions,
    calls: plan.calls,
    skipped: plan.skipped,
    ...(semanticCoverage ? { semanticCoverage } : {}),
    digests: loaded.digests,
  };
}

async function compareResults(resultDir: string, baselineDir: string): Promise<unknown> {
  await verifyResult(resultDir);
  await verifyResult(baselineDir);
  const [resultManifest, baselineManifest] = await Promise.all(
    [resultDir, baselineDir].map(async (directory) =>
      JSON.parse(await readFile(join(resolve(directory), "manifest.json"), "utf8")) as {
        compatibility?: Record<string, string>;
      },
    ),
  );
  const comparableFields = [
    "configDigest",
    "suiteDigest",
    "datasetDigest",
    "oracleDigest",
    "scorerDigest",
    "variantDigest",
  ] as const;
  const incompatible = comparableFields.filter(
    (field) =>
      resultManifest?.compatibility?.[field] !==
      baselineManifest?.compatibility?.[field],
  );
  if (incompatible.length) {
    throw new Error(
      `results are not in the same comparison cohort: ${incompatible.join(", ")}`,
    );
  }
  const summaries = await Promise.all(
    [resultDir, baselineDir].map(async (directory) =>
      JSON.parse(await readFile(join(resolve(directory), "summary.json"), "utf8")) as {
        taskPassRate: number;
        macro: Record<string, number>;
        executionFailures: number;
        safetyGateFailures: number;
        tasks: Array<{
          key: string;
          majorityPass: boolean;
          vector: Record<string, number>;
        }>;
      },
    ),
  );
  const current = summaries[0]!;
  const baseline = summaries[1]!;
  const baselineTasks = new Map(baseline.tasks.map((task) => [task.key, task]));
  const pairedTasks = current.tasks.flatMap((task) => {
    const previous = baselineTasks.get(task.key);
    if (!previous) return [];
    return [
      {
        key: task.key,
        verdictDelta: Number(task.majorityPass) - Number(previous.majorityPass),
        vectorDelta: Object.fromEntries(
          Object.keys(task.vector).map((key) => [
            key,
            (task.vector[key] ?? 0) - (previous.vector[key] ?? 0),
          ]),
        ),
      },
    ];
  });
  const meanPairedGroundTruthDelta = pairedTasks.length
    ? pairedTasks.reduce(
        (sum, task) => sum + Number(task.vectorDelta.groundTruth ?? 0),
        0,
      ) / pairedTasks.length
    : null;
  return {
    schemaVersion: "openneko.eval.comparison/v1",
    result: resolve(resultDir),
    baseline: resolve(baselineDir),
    delta: {
      taskPassRate: current.taskPassRate - baseline.taskPassRate,
      macro: Object.fromEntries(
        Object.keys(current.macro).map((key) => [
          key,
          (current.macro[key] ?? 0) - (baseline.macro[key] ?? 0),
        ]),
      ),
      executionFailures: current.executionFailures - baseline.executionFailures,
      safetyGateFailures: current.safetyGateFailures - baseline.safetyGateFailures,
    },
    paired: {
      tasks: pairedTasks.length,
      meanGroundTruthDelta: meanPairedGroundTruthDelta,
      taskDeltas: pairedTasks,
    },
  };
}

export async function runEvalCli(
  argv: readonly string[],
  options: EvalCliOptions,
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const cwd = resolve(options.cwd ?? process.cwd());
  const command = argv[0];
  const args = argv.slice(1);
  if (!command || command === "help" || has(args, "--help")) {
    stdout.write(usage());
    return 0;
  }

  if (command === "validate") {
    const { loaded, plan } = await loadContext(args, cwd);
    if (!options.adapters[loaded.config.adapter]) {
      throw new Error(`unknown eval adapter ${loaded.config.adapter}`);
    }
    stdout.write(
      `valid ${loaded.config.id}: ${loaded.cases.length} cases, ${loaded.config.variants.length} variants, ${plan.calls} calls\n`,
    );
    return 0;
  }
  if (command === "plan") {
    const { loaded, plan } = await loadContext(args, cwd);
    if (!options.adapters[loaded.config.adapter]) {
      throw new Error(`unknown eval adapter ${loaded.config.adapter}`);
    }
    const document = planDocument(loaded, plan);
    if (has(args, "--json")) stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    else {
      stdout.write(
        `${plan.configId}: ${loaded.cases.length} cases × ${loaded.config.variants.length} variants × ${plan.repetitions} repetitions = ${plan.calls} calls\n`,
      );
      for (const variant of loaded.config.variants) {
        stdout.write(
          `  ${variant.id}: ${variant.backend} / ${variant.outer_model.provider}:${variant.outer_model.model} / ${variant.data_path}\n`,
        );
      }
      for (const skipped of plan.skipped) {
        stdout.write(`  skipped ${skipped.variantId}/${skipped.caseId}: ${skipped.reason}\n`);
      }
    }
    return 0;
  }
  if (command === "oracles") {
    const { loaded, plan } = await loadContext(args, cwd);
    const factory = options.adapters[loaded.config.adapter];
    if (!factory) throw new Error(`unknown eval adapter ${loaded.config.adapter}`);
    const driver = await factory({ loaded, plan });
    try {
      const values: Record<string, unknown> = {};
      for (const evalCase of loaded.cases) {
        values[evalCase.id] = await driver.resolveOracle(evalCase, {
          loaded,
          plan,
        });
      }
      const document = {
        schemaVersion: "openneko.eval.oracles/v1",
        configId: plan.configId,
        suiteId: plan.suiteId,
        adapter: plan.adapter,
        datasetDigest: loaded.digests.datasets,
        digest: contentDigest(values),
        values,
      };
      const outPath = flag(args, "--out");
      if (outPath) {
        const target = resolve(cwd, outPath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
      }
      if (has(args, "--json") || !outPath) {
        if (has(args, "--json")) {
          stdout.write(`${JSON.stringify(document, null, 2)}\n`);
        } else {
          stdout.write(
            `${plan.configId}: resolved ${loaded.cases.length} oracles (digest ${document.digest})\n`,
          );
          for (const evalCase of loaded.cases) {
            stdout.write(
              `  ${evalCase.id}: ${JSON.stringify(values[evalCase.id])}\n`,
            );
          }
        }
      } else {
        stdout.write(
          `${plan.configId}: resolved ${loaded.cases.length} oracles (digest ${document.digest}) -> ${outPath}\n`,
        );
      }
      return 0;
    } finally {
      await driver.close?.();
    }
  }
  if (command === "run" || command === "resume" || command === "rescore") {
    const { loaded, plan } = await loadContext(args, cwd);
    const factory = options.adapters[loaded.config.adapter];
    if (!factory) throw new Error(`unknown eval adapter ${loaded.config.adapter}`);
    const driver = await factory({ loaded, plan });
    const stateRoot = resolve(cwd, loaded.config.artifacts.state_dir);
    const resultsRoot = resolve(cwd, loaded.config.artifacts.results_dir);
    if (command === "rescore") {
      const result = await rescoreEvaluation({
        loaded,
        plan,
        driver,
        stateRoot,
        runId: requireFlag(args, "--run"),
      });
      stdout.write(`rescored without model calls: ${result.path}\n`);
      return 0;
    }
    const resumeRunId =
      command === "resume" ? requireFlag(args, "--run") : flag(args, "--resume");
    const result = await runEvaluation({
      loaded,
      plan,
      driver,
      cwd,
      stateRoot,
      resultsRoot,
      ...(resumeRunId ? { resumeRunId } : {}),
      restart: has(args, "--restart"),
      ...(has(args, "--promote")
        ? { promote: true }
        : has(args, "--no-promote")
          ? { promote: false }
          : {}),
    });
    stdout.write(
      `${result.resumed ? "resumed" : "completed"} ${result.runId}; reused ${result.reusedEpisodes} episodes${
        result.resultDir ? `; result ${result.resultDir}` : ""
      }\n`,
    );
    return result.gatesPassed ? 0 : 2;
  }
  if (command === "verify") {
    const result = await verifyResult(
      resolve(cwd, requireFlag(args, "--result")),
    );
    stdout.write(
      `verified ${result.runId}: ${result.episodes} episodes (${result.digest}); gates ${result.gatesPassed ? "passed" : "failed"}\n`,
    );
    return result.gatesPassed ? 0 : 2;
  }
  if (command === "report") {
    stdout.write(
      await renderStoredReport(resolve(cwd, requireFlag(args, "--result"))),
    );
    return 0;
  }
  if (command === "compare") {
    const comparison = await compareResults(
      resolve(cwd, requireFlag(args, "--result")),
      resolve(cwd, requireFlag(args, "--baseline")),
    );
    stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    return 0;
  }
  throw new Error(`unknown eval command ${command}\n\n${usage()}`);
}
