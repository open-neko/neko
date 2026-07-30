/**
 * Live, checkpointed Hermes A/B experiment for OpenNeko's GraphJin data path.
 *
 * Control:   Hermes writes GraphQL and calls execute_graphql.
 * Treatment: Hermes delegates the data goal to GraphJin's built-in read-only
 *            server agent through the same trusted host broker.
 *
 * The companion scripts/graphjin-agent-ab.ts runner supplies live,
 * database-derived ground truth. Every completed arm is written to the report
 * immediately so a long experiment can be inspected or resumed safely.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  provisionHostConfig,
  runMetricAgent,
  type GraphjinDataPath,
  type MetricAgentDiagnostics,
  type MetricAgentResult,
} from "@neko/llm";
import {
  GRAPHJIN_AB_CASES,
  selectGraphjinAbCases,
  type GraphjinAbCaseDefinition,
} from "../../scripts/graphjin-agent-ab-cases";
import { validateResult } from "../../src/jobs/metric-refresh.js";
import { seedE2ETestOrg } from "./_seed-org";
import { applyPlan } from "./_set-backend";
import { parseHeadline } from "./_parse-headline";
import type { RunPlan } from "./_can-run";

const graphjinUrl =
  process.env.NEKO_GRAPHJIN_AGENT_AB_URL?.trim() ||
  "http://localhost:8082/api/v1/graphql";
const reportPath =
  process.env.NEKO_GRAPHJIN_AB_REPORT?.trim() ||
  `.openneko/experiments/graphjin-agent-ab-20q-${Date.now()}.json`;
const baselineReport =
  process.env.NEKO_GRAPHJIN_AGENT_AB_BASELINE_REPORT?.trim();
const selectedCases = selectGraphjinAbCases(
  process.env.NEKO_GRAPHJIN_AGENT_AB_CASE_IDS,
);
const selectedArms = parseSelectedArms(
  process.env.NEKO_GRAPHJIN_AGENT_AB_ARMS,
);

type CaseGroundTruth = {
  caseId: string;
  anchorDate: string;
  startDate: string;
  expectedValue: number;
  baselineValue: number;
  expectedDimension?: string;
};

type AgentProbe = {
  ok: boolean;
  durationMs: number;
  httpStatus?: number;
  responseStatus?: string;
  response?: {
    status?: string;
    answer?: string;
    data?: unknown;
    evidence?: unknown;
    usage?: unknown;
    errors?: Array<{ message?: string }>;
    next?: unknown;
  };
  error?: string;
};

type ExperimentRecord = {
  caseId: string;
  question: string;
  category: string;
  difficulty: GraphjinAbCaseDefinition["difficulty"];
  backend: "hermes";
  arm: GraphjinDataPath;
  status: "completed" | "failed";
  wallDurationMs: number;
  expectedValue: number;
  baselineValue: number;
  expectedDimension?: string;
  expectedTimeWindow: {
    grain: GraphjinAbCaseDefinition["expectedGrain"];
    start: string;
    end: string;
  };
  headline?: string;
  parsedHeadline?: number | null;
  relativeError?: number | null;
  numericExact?: boolean;
  numericWithinTolerance?: boolean;
  timeWindowCorrect?: boolean;
  dimensionCorrect?: boolean;
  overallCorrect?: boolean;
  validationError?: string;
  timeWindow?: unknown;
  output?: MetricAgentResult;
  diagnostics?: MetricAgentDiagnostics;
  error?: string;
  source?: "baseline" | "live";
};

type ArmSummary = {
  arm: GraphjinDataPath;
  measuredQuestions: number;
  completed: number;
  executionFailures: number;
  validOutputs: number;
  exactNumeric: number;
  withinTolerance: number;
  correctTimeWindow: number;
  dimensionQuestions: number;
  correctDimension: number;
  overallCorrect: number;
  overallAccuracyRate: number;
  totalWallDurationMs: number;
  meanWallDurationMs: number;
  medianWallDurationMs: number;
  tokenCoverage: number;
  totalTokens: number;
  meanTokens: number;
  outerTokens: number;
  innerTokenCoverage: number;
  innerTokens: number;
};

const groundTruth = parseGroundTruth();
const groundTruthById = new Map(
  groundTruth.map((item) => [item.caseId, item]),
);
const definitionsById = new Map(
  GRAPHJIN_AB_CASES.map((item) => [item.id, item]),
);
const records: ExperimentRecord[] = [];
const preflight = parsePreflight();
const plan = experimentPlan();
let orgId = "";
let cleanup: (() => Promise<void>) | undefined;

function experimentPlan(): RunPlan | undefined {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    id: "hermes+gemini",
    backend: "hermes",
    primaryProvider: "google-gemini",
    primaryModel:
      process.env.NEKO_E2E_HERMES_MODEL?.trim() || "gemini-3.6-flash",
    apiKey,
  };
}

function parseGroundTruth(): CaseGroundTruth[] {
  const raw = process.env.NEKO_GRAPHJIN_AGENT_AB_GROUND_TRUTH?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as CaseGroundTruth[];
  return parsed.map((item) => ({
    ...item,
    expectedValue: Number(item.expectedValue),
    baselineValue: Number(item.baselineValue),
  }));
}

function parsePreflight(): AgentProbe {
  const raw = process.env.NEKO_GRAPHJIN_AGENT_AB_PREFLIGHT?.trim();
  if (!raw) {
    return {
      ok: false,
      durationMs: 0,
      error: "GraphJin inner-agent preflight was not supplied",
    };
  }
  try {
    return JSON.parse(raw) as AgentProbe;
  } catch {
    return {
      ok: false,
      durationMs: 0,
      error: "GraphJin inner-agent preflight was invalid JSON",
    };
  }
}

function parseSelectedArms(raw: string | undefined): GraphjinDataPath[] {
  if (!raw?.trim()) return ["direct", "agent"];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = values.filter(
    (value) => value !== "direct" && value !== "agent",
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown GraphJin A/B arms: ${unknown.join(", ")}`);
  }
  return [...new Set(values)] as GraphjinDataPath[];
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /([?&](?:key|api_key|access_token|token)=)[^&\s"'\\]+/giu,
      "$1[REDACTED]",
    )
    .replace(/AIza[0-9A-Za-z_-]+/gu, "[REDACTED_GOOGLE_API_KEY]");
}

function sanitizeForArtifact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? redactSensitiveText(nested) : nested,
    ),
  ) as T;
}

async function assertAgentReady(): Promise<void> {
  const statusUrl = graphjinUrl.replace(
    /\/api\/v1\/graphql\/?$/,
    "/api/v1/agent/status",
  );
  const res = await fetch(statusUrl);
  expect(res.ok, `GraphJin agent status HTTP ${res.status}`).toBe(true);
  const status = (await res.json()) as {
    ready?: boolean;
    read_only?: boolean;
    message?: string;
  };
  expect(status.ready, status.message || "GraphJin agent is not ready").toBe(
    true,
  );
  expect(status.read_only, "A/B treatment requires agent.read_only=true").toBe(
    true,
  );
}

async function configureRuntime(): Promise<void> {
  process.env.OPENNEKO_AGENT_MODEL_PROVIDER =
    process.env.NEKO_E2E_HERMES_OPENSHELL_PROVIDER?.trim() ||
    "openneko-gemini";
  process.env.OPENNEKO_AGENT_MODEL_HOST =
    "generativelanguage.googleapis.com,models.dev";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  process.env.OPENNEKO_AGENT_MODEL_BINARY =
    `/usr/local/uv/python/cpython-3.11.15-linux-${arch}-gnu/bin/python3.11`;
  process.env.OPENNEKO_AGENT_MODEL_KEY_ENV = "GEMINI_API_KEY";
  delete process.env.OPENNEKO_AGENT_HERMES_HOME;
  await provisionHostConfig(orgId);
}

function scoreOutput(
  definition: GraphjinAbCaseDefinition,
  truth: CaseGroundTruth,
  output: MetricAgentResult,
): Pick<
  ExperimentRecord,
  | "headline"
  | "parsedHeadline"
  | "relativeError"
  | "numericExact"
  | "numericWithinTolerance"
  | "timeWindowCorrect"
  | "dimensionCorrect"
  | "overallCorrect"
  | "validationError"
  | "timeWindow"
> {
  const headline = output.headlineMetric;
  const parsedHeadline =
    parseHeadline(headline) ??
    parseHeadline(headline.match(/^[\s$]*[+-]?[\d,.]+(?:\.\d+)?[kmb]?/i)?.[0] ?? "") ??
    output.chartData[0]?.v ??
    null;
  const relativeError =
    parsedHeadline == null
      ? null
      : Math.abs(parsedHeadline - truth.expectedValue) /
        Math.abs(truth.expectedValue);
  const numericExact =
    parsedHeadline != null && parsedHeadline === truth.expectedValue;
  const numericWithinTolerance =
    relativeError != null && relativeError <= definition.maxRelativeError;
  const timeWindowCorrect =
    output.timeWindow.grain === definition.expectedGrain &&
    output.timeWindow.start === truth.startDate &&
    output.timeWindow.end === truth.anchorDate;
  const dimensionCorrect =
    !truth.expectedDimension ||
    JSON.stringify(output)
      .toLocaleLowerCase()
      .includes(truth.expectedDimension.toLocaleLowerCase());
  const validationError = validateResult(output) ?? undefined;
  return {
    headline,
    parsedHeadline,
    relativeError,
    numericExact,
    numericWithinTolerance,
    timeWindowCorrect,
    dimensionCorrect,
    overallCorrect:
      !validationError &&
      numericWithinTolerance &&
      timeWindowCorrect &&
      dimensionCorrect,
    ...(validationError ? { validationError } : {}),
    timeWindow: output.timeWindow,
  };
}

function upsertRecord(record: ExperimentRecord): void {
  const index = records.findIndex(
    (item) => item.caseId === record.caseId && item.arm === record.arm,
  );
  if (index === -1) records.push(record);
  else records[index] = record;
}

function armSummary(arm: GraphjinDataPath): ArmSummary {
  const armRecords = records.filter((item) => item.arm === arm);
  const completed = armRecords.filter(
    (item) => item.status === "completed",
  ).length;
  const durations = armRecords
    .map((item) => item.wallDurationMs)
    .sort((a, b) => a - b);
  const tokens = armRecords.flatMap((item) =>
    item.diagnostics?.totalTokens == null
      ? []
      : [item.diagnostics.totalTokens],
  );
  const innerTokens = armRecords.flatMap((item) =>
    item.diagnostics?.innerTokens?.totalTokens == null
      ? []
      : [item.diagnostics.innerTokens.totalTokens],
  );
  const totalWallDurationMs = durations.reduce((sum, value) => sum + value, 0);
  const totalTokens = tokens.reduce((sum, value) => sum + value, 0);
  const totalInnerTokens = innerTokens.reduce(
    (sum, value) => sum + value,
    0,
  );
  const medianWallDurationMs =
    durations.length === 0
      ? 0
      : durations.length % 2 === 1
        ? durations[Math.floor(durations.length / 2)]!
        : (durations[durations.length / 2 - 1]! +
            durations[durations.length / 2]!) /
          2;
  const dimensionRecords = armRecords.filter(
    (item) => item.expectedDimension,
  );
  const overallCorrect = armRecords.filter(
    (item) => item.overallCorrect,
  ).length;
  return {
    arm,
    measuredQuestions: armRecords.length,
    completed,
    executionFailures: armRecords.length - completed,
    validOutputs: armRecords.filter(
      (item) => item.status === "completed" && !item.validationError,
    ).length,
    exactNumeric: armRecords.filter((item) => item.numericExact).length,
    withinTolerance: armRecords.filter(
      (item) => item.numericWithinTolerance,
    ).length,
    correctTimeWindow: armRecords.filter(
      (item) => item.timeWindowCorrect,
    ).length,
    dimensionQuestions: dimensionRecords.length,
    correctDimension: dimensionRecords.filter(
      (item) => item.dimensionCorrect,
    ).length,
    overallCorrect,
    overallAccuracyRate:
      armRecords.length === 0 ? 0 : overallCorrect / armRecords.length,
    totalWallDurationMs,
    meanWallDurationMs:
      durations.length === 0 ? 0 : totalWallDurationMs / durations.length,
    medianWallDurationMs,
    tokenCoverage: tokens.length,
    totalTokens,
    meanTokens: tokens.length === 0 ? 0 : totalTokens / tokens.length,
    outerTokens: armRecords.reduce(
      (sum, item) =>
        sum + (item.diagnostics?.outerTokens?.totalTokens ?? 0),
      0,
    ),
    innerTokenCoverage: innerTokens.length,
    innerTokens: totalInnerTokens,
  };
}

function reportDocument(): unknown {
  const sortedRecords = [...records].sort(
    (a, b) =>
      a.caseId.localeCompare(b.caseId) || a.arm.localeCompare(b.arm),
  );
  const measuredQuestions = new Set(records.map((item) => item.caseId)).size;
  return sanitizeForArtifact({
    generatedAt: new Date().toISOString(),
    status:
      measuredQuestions === GRAPHJIN_AB_CASES.length &&
      records.length === GRAPHJIN_AB_CASES.length * 2
        ? "complete"
        : "partial",
    suite: {
      totalQuestions: GRAPHJIN_AB_CASES.length,
      selectedCaseIds: selectedCases.map((item) => item.id),
      selectedArms,
      measuredQuestions,
      baselineReport,
      scoring:
        "Overall correctness requires valid output, <=1% numeric error, exact time window, and the expected ranked dimension when applicable. Exact numeric accuracy is reported separately.",
    },
    graphjinUrl,
    graphjin: {
      image: process.env.NEKO_GRAPHJIN_AGENT_AB_IMAGE,
      sourceVersion: process.env.NEKO_GRAPHJIN_AGENT_AB_SOURCE_VERSION,
      model: process.env.NEKO_GRAPHJIN_AGENT_AB_MODEL,
      preflight,
    },
    openNekoAgentImage:
      process.env.NEKO_GRAPHJIN_AGENT_AB_OPENNEKO_IMAGE,
    questions: GRAPHJIN_AB_CASES.map((definition) => {
      const truth = groundTruthById.get(definition.id);
      return {
        id: definition.id,
        title: definition.title,
        why: definition.why,
        category: definition.category,
        difficulty: definition.difficulty,
        metricType: definition.metricType,
        expectedGrain: definition.expectedGrain,
        maxRelativeError: definition.maxRelativeError,
        groundTruth: truth,
      };
    }),
    summary: {
      direct: armSummary("direct"),
      agent: armSummary("agent"),
    },
    records: sortedRecords,
  });
}

async function persistReport(): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  const temporaryPath = `${reportPath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(reportDocument(), null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, reportPath);
}

async function loadBaseline(): Promise<void> {
  if (!baselineReport) return;
  const parsed = JSON.parse(await readFile(baselineReport, "utf8")) as {
    records?: Array<{
      caseId?: string;
      backend?: string;
      arm?: GraphjinDataPath;
      status?: string;
      wallDurationMs?: number;
      output?: MetricAgentResult;
      diagnostics?: MetricAgentDiagnostics;
      error?: string;
    }>;
  };
  for (const source of parsed.records ?? []) {
    if (
      source.backend !== "hermes" ||
      (source.arm !== "direct" && source.arm !== "agent")
    ) {
      continue;
    }
    const caseId = source.caseId ?? "q01";
    const definition = definitionsById.get(caseId);
    const truth = groundTruthById.get(caseId);
    if (!definition || !truth) continue;
    const base: ExperimentRecord = {
      caseId: definition.id,
      question: definition.title,
      category: definition.category,
      difficulty: definition.difficulty,
      backend: "hermes",
      arm: source.arm,
      status:
        source.status === "failed" || !source.output ? "failed" : "completed",
      wallDurationMs: source.wallDurationMs ?? 0,
      expectedValue: truth.expectedValue,
      baselineValue: truth.baselineValue,
      ...(truth.expectedDimension
        ? { expectedDimension: truth.expectedDimension }
        : {}),
      expectedTimeWindow: {
        grain: definition.expectedGrain,
        start: truth.startDate,
        end: truth.anchorDate,
      },
      ...(source.output
        ? {
            ...scoreOutput(definition, truth, source.output),
            output: source.output,
          }
        : {}),
      ...(source.diagnostics ? { diagnostics: source.diagnostics } : {}),
      ...(source.error
        ? { error: redactSensitiveText(source.error) }
        : {}),
      source: "baseline",
    };
    upsertRecord(base);
  }
}

beforeAll(async () => {
  if (!plan) return;
  for (const definition of GRAPHJIN_AB_CASES) {
    const truth = groundTruthById.get(definition.id);
    expect(
      truth,
      `runner must supply ground truth for ${definition.id}`,
    ).toBeDefined();
    expect(Number.isFinite(truth!.expectedValue)).toBe(true);
    expect(Number.isFinite(truth!.baselineValue)).toBe(true);
    expect(truth!.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(truth!.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  await loadBaseline();
  await persistReport();
  await assertAgentReady();
  const seeded = await seedE2ETestOrg({
    graphqlUrl: graphjinUrl,
    initialPlan: plan,
  });
  orgId = seeded.orgId;
  cleanup = seeded.cleanup;
  await applyPlan(orgId, plan);
  await configureRuntime();
});

afterAll(async () => {
  await cleanup?.();
  if (records.length === 0) return;
  await persistReport();

  console.table(
    records.map((record) => ({
      case: record.caseId,
      arm: record.arm,
      status: record.status,
      correct: record.overallCorrect ?? false,
      seconds: (record.wallDurationMs / 1_000).toFixed(1),
      expected: record.expectedValue,
      headline: record.headline ?? "—",
      errorPct:
        record.relativeError == null
          ? "—"
          : `${(record.relativeError * 100).toFixed(3)}%`,
      window: record.timeWindowCorrect ?? false,
      dimension: record.dimensionCorrect ?? false,
      outerTokens: record.diagnostics?.outerTokens?.totalTokens ?? "—",
      innerTokens: record.diagnostics?.innerTokens?.totalTokens ?? "—",
      totalTokens: record.diagnostics?.totalTokens ?? "—",
    })),
  );
  console.table([armSummary("direct"), armSummary("agent")]);
  console.log(`[graphjin-agent-ab] report=${reportPath}`);
});

const describeLive = plan ? describe : describe.skip;

describeLive("GraphJin server-agent 20-question Hermes A/B", () => {
  if (!plan) {
    it.skip("requires a live Gemini-backed Hermes plan", () => {});
    return;
  }
  for (const definition of selectedCases) {
    const truth = groundTruthById.get(definition.id);
    if (!truth) {
      throw new Error(`Missing ground truth for ${definition.id}`);
    }

    for (const arm of selectedArms) {
      it(
        `${definition.id} ${arm}: ${definition.title}`,
        async () => {
          const startedAt = Date.now();
          let diagnostics: MetricAgentDiagnostics | undefined;
          try {
            if (
              arm === "agent" &&
              preflight.httpStatus == null &&
              preflight.responseStatus == null
            ) {
              throw new Error(
                `GraphJin inner-agent preflight produced no response after ${preflight.durationMs}ms: ${
                  preflight.error || "unknown error"
                }`,
              );
            }
            const output = await runMetricAgent({
              orgId,
              role: definition.role,
              slug: definition.slug,
              title: definition.title,
              why: definition.why,
              chartHint: definition.chartHint,
              jobId: randomUUID(),
              graphjinPath: arm,
              onDiagnostics: (value) => {
                diagnostics = value;
              },
            });
            const score = scoreOutput(definition, truth, output);
            upsertRecord({
              caseId: definition.id,
              question: definition.title,
              category: definition.category,
              difficulty: definition.difficulty,
              backend: "hermes",
              arm,
              status: "completed",
              wallDurationMs: Date.now() - startedAt,
              expectedValue: truth.expectedValue,
              baselineValue: truth.baselineValue,
              ...(truth.expectedDimension
                ? { expectedDimension: truth.expectedDimension }
                : {}),
              expectedTimeWindow: {
                grain: definition.expectedGrain,
                start: truth.startDate,
                end: truth.anchorDate,
              },
              ...score,
              output,
              diagnostics,
              source: "live",
            });
          } catch (cause) {
            const message = redactSensitiveText(
              cause instanceof Error ? cause.message : String(cause),
            );
            upsertRecord({
              caseId: definition.id,
              question: definition.title,
              category: definition.category,
              difficulty: definition.difficulty,
              backend: "hermes",
              arm,
              status: "failed",
              wallDurationMs: Date.now() - startedAt,
              expectedValue: truth.expectedValue,
              baselineValue: truth.baselineValue,
              ...(truth.expectedDimension
                ? { expectedDimension: truth.expectedDimension }
                : {}),
              expectedTimeWindow: {
                grain: definition.expectedGrain,
                start: truth.startDate,
                end: truth.anchorDate,
              },
              diagnostics,
              error: message,
              source: "live",
            });
          }
          await persistReport();
          const measured = records.find(
            (item) =>
              item.caseId === definition.id && item.arm === arm,
          )!;
          console.log(
            `[graphjin-agent-ab] ${definition.id} arm=${arm} status=${measured.status} correct=${measured.overallCorrect ?? false} duration=${(measured.wallDurationMs / 1_000).toFixed(1)}s tokens=${measured.diagnostics?.totalTokens ?? "unavailable"}`,
          );
        },
        15 * 60_000,
      );
    }
  }
});
