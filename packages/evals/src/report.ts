import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contentDigest, textDigest } from "./canonical";
import { redactText } from "@neko/telemetry";
import { summarizeEpisodes } from "./scoring";
import {
  EpisodeSchema,
  ManifestSchema,
  ResultLineSchema,
  ResultManifestSchema,
  SummarySchema,
  type EvalEpisode,
  type EvalManifest,
} from "./schemas";

const SECRET_SHAPE =
  /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{12,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/u;
const CONTENT_KEY =
  /(?:prompt|response|completion|message|query|sql|graphql|tool[._-]?(?:input|output|result|argument)|content|body|secret|password|api[._-]?key|authorization|cookie)/iu;
const CREDENTIAL_KEY =
  /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)$/iu;
const MAX_CHECKED_ARTIFACT_BYTES = 10 * 1024 * 1024;

function assertNoLiteralCredentials(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLiteralCredentials(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      CREDENTIAL_KEY.test(key) &&
      typeof nested === "string" &&
      !/^env:[A-Z][A-Z0-9_]*$/u.test(nested)
    ) {
      throw new Error(`${path}.${key} contains a literal credential`);
    }
    assertNoLiteralCredentials(nested, `${path}.${key}`);
  }
}

function sanitizePublicValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactText(value).slice(0, 2048);
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((item) => sanitizePublicValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !CONTENT_KEY.test(key))
        .map(([key, nested]) => [key, sanitizePublicValue(nested, depth + 1)]),
    );
  }
  return String(value).slice(0, 256);
}

function markdown(summary: ReturnType<typeof summarizeEpisodes>, manifest: EvalManifest): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const accepted = evaluateSuiteGates(summary, manifest.suiteGates);
  const duration = (value: number | null) =>
    value === null ? "unavailable" : `${Math.round(value)} ms`;
  const money = (value: { count: number; coverage: number; total: number }) =>
    value.count === 0
      ? "unavailable"
      : `$${value.total.toFixed(6)} (${pct(value.coverage)} coverage)`;
  const capabilityGates = Object.entries(
    manifest.suiteGates.min_capability_task_pass_rate ?? {},
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capability, minimum]) => {
      const actual = summary.byCapability[capability]?.passRate;
      return `${capability}=${actual === undefined ? "missing" : pct(actual)} (min ${pct(minimum)})`;
    });
  return `# Eval result: ${manifest.configId}\n\n` +
    `- Run: \`${manifest.runId}\`\n` +
    `- Suite: \`${manifest.suiteId}\`\n` +
    `- Attestation: ${manifest.attestation}\n` +
    `- Accepted: ${accepted ? "yes" : "no"}\n` +
    `- Source: \`${manifest.source.commit}\`${manifest.source.dirty ? " (dirty)" : ""}\n` +
    `- Task pass rate: ${pct(summary.taskPassRate)} (${summary.passedTasks}/${summary.taskCount})\n` +
    `- Macro ground truth: ${pct(summary.macro.groundTruth)}\n` +
    `- Macro method: ${pct(summary.macro.method)}\n` +
    `- Macro behavior: ${pct(summary.macro.behavior)}\n` +
    `- Macro safety: ${pct(summary.macro.safety)}\n` +
    `- Macro efficiency: ${pct(summary.macro.efficiency)}\n` +
    `- Method score coverage: ${pct(summary.coverage.method)}\n` +
    `- Safety score coverage: ${pct(summary.coverage.safety)}\n` +
    `- Efficiency score coverage: ${pct(summary.coverage.efficiency)}\n` +
    `- Mean consistency: ${pct(summary.meanConsistency)}\n` +
    `- Wall latency p50 / p95: ${duration(summary.measurements.wallDurationMs.p50)} / ${duration(summary.measurements.wallDurationMs.p95)}\n` +
    `- Tool calls mean / p95: ${summary.measurements.toolCalls.mean ?? "unavailable"} / ${summary.measurements.toolCalls.p95 ?? "unavailable"}\n` +
    `- Exact repeated tool calls: ${summary.measurements.repeatedToolCalls.total} (${pct(summary.measurements.repeatedToolCalls.coverage)} coverage)\n` +
    `- Total tokens: ${summary.measurements.totalTokens.total} (${pct(summary.measurements.totalTokens.coverage)} coverage)\n` +
    `- Estimated / billed cost: ${money(summary.measurements.estimatedCostUsd)} / ${money(summary.measurements.billedCostUsd)}\n` +
    `- Complete / available usage coverage: ${pct(summary.measurements.usageCoverage.completeRate)} / ${pct(summary.measurements.usageCoverage.availableRate)}\n` +
    `- Complete / available cost coverage: ${pct(summary.measurements.costCoverage.completeRate)} / ${pct(summary.measurements.costCoverage.availableRate)}\n` +
    `- Datasets / product paths: ${Object.keys(summary.byDataset).length} / ${Object.keys(summary.byProductPath).length}\n` +
    `- Semantic IDs exercised: ${Object.keys(summary.bySemantic).length}\n` +
    `- Execution failures: ${summary.executionFailures}\n` +
    `- Safety gate failures: ${summary.safetyGateFailures}\n` +
    `- Unsafe effects: ${summary.unsafeEffects} across ${summary.unsafeEffectEpisodes} episodes${
      Object.keys(summary.unsafeEffectsByKind).length
        ? ` (${Object.entries(summary.unsafeEffectsByKind)
            .map(([kind, count]) => `${kind}=${count}`)
            .join(", ")})`
        : ""
    }\n` +
    (capabilityGates.length
      ? `- Capability gates: ${capabilityGates.join(", ")}\n`
      : "");
}

export function evaluateSuiteGates(
  summary: ReturnType<typeof summarizeEpisodes>,
  gates: EvalManifest["suiteGates"],
): boolean {
  return (
    summary.executionFailures === 0 &&
    (gates.min_macro_ground_truth === undefined ||
      summary.macro.groundTruth >= gates.min_macro_ground_truth) &&
    (gates.min_method === undefined ||
      summary.macro.method >= gates.min_method) &&
    (gates.min_behavior === undefined ||
      summary.macro.behavior >= gates.min_behavior) &&
    (gates.min_full_task_pass_rate === undefined ||
      summary.taskPassRate >= gates.min_full_task_pass_rate) &&
    (gates.min_token_usage_coverage === undefined ||
      summary.measurements.usageCoverage.completeRate >=
        gates.min_token_usage_coverage) &&
    Object.entries(gates.min_capability_task_pass_rate ?? {}).every(
      ([capability, minimum]) =>
        (summary.byCapability[capability]?.passRate ?? -1) >= minimum,
    ) &&
    (gates.max_unsafe_effects === undefined ||
      summary.unsafeEffects <= gates.max_unsafe_effects) &&
    (!gates.require_safety || summary.safetyGateFailures === 0)
  );
}

function publicEpisode(episode: EvalEpisode): unknown {
  return {
    schemaVersion: "openneko.eval.result/v1",
    runId: episode.runId,
    slotKey: episode.slotKey,
    ...(episode.pairKey ? { pairKey: episode.pairKey } : {}),
    ...(episode.treatment ? { treatment: episode.treatment } : {}),
    caseId: episode.caseId,
    caseContentId: episode.caseContentId,
    family: episode.family,
    productPath: episode.productPath,
    difficulty: episode.difficulty,
    capabilityTags: episode.capabilityTags,
    semantics: episode.semantics,
    variantId: episode.variantId,
    datasetId: episode.datasetId,
    repetition: episode.repetition,
    phase: episode.phase,
    attempt: episode.attempt,
    startedAt: episode.startedAt,
    finishedAt: episode.finishedAt,
    status: episode.status,
    measurements: sanitizePublicValue(episode.measurements),
    score: episode.score,
    ...(episode.errorType ? { errorType: episode.errorType } : {}),
    ...(episode.error ? { error: redactText(episode.error) } : {}),
    episodeDigest: episode.integrityDigest,
  };
}

export async function promoteResult(input: {
  manifest: EvalManifest;
  episodes: readonly EvalEpisode[];
  resultsRoot: string;
  rescore?: {
    sourceRunManifestDigest: string;
    sourceRescoreDigest: string;
    scorer: { id: string; version: string };
    scorerDigest: string;
  };
}): Promise<string> {
  const resultDir = resolve(input.resultsRoot, input.manifest.configId, input.manifest.runId);
  await mkdir(resultDir, { recursive: true });
  const sorted = [...input.episodes].sort((left, right) =>
    left.slotKey.localeCompare(right.slotKey),
  );
  const lines = sorted.map((episode) => JSON.stringify(publicEpisode(episode))).join("\n") + "\n";
  const summary = SummarySchema.parse(summarizeEpisodes(sorted));
  const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
  const markdownText = markdown(summary, input.manifest);
  const accepted = evaluateSuiteGates(summary, input.manifest.suiteGates);
  const compatibility = input.rescore
    ? {
        ...input.manifest.compatibility,
        scorerDigest: input.rescore.scorerDigest,
      }
    : input.manifest.compatibility;
  await writeFile(join(resultDir, "results.jsonl"), lines, "utf8");
  await writeFile(join(resultDir, "summary.json"), summaryText, "utf8");
  await writeFile(join(resultDir, "summary.md"), markdownText, "utf8");
  const artifactManifest = ResultManifestSchema.parse({
    schemaVersion: "openneko.eval.result-manifest/v1",
    runId: input.manifest.runId,
    configId: input.manifest.configId,
    suiteId: input.manifest.suiteId,
    attestation: input.manifest.attestation,
    accepted,
    suiteGates: input.manifest.suiteGates,
    sourceRunManifestDigest:
      input.rescore?.sourceRunManifestDigest ?? contentDigest(input.manifest),
    ...(input.rescore
      ? {
          rescore: {
            sourceRescoreDigest: input.rescore.sourceRescoreDigest,
            scorerId: input.rescore.scorer.id,
            scorerVersion: input.rescore.scorer.version,
            scorerDigest: input.rescore.scorerDigest,
          },
        }
      : {}),
    source: input.manifest.source,
    compatibility,
    ...(input.manifest.datasetFingerprint !== undefined
      ? {
          datasetFingerprint: sanitizePublicValue(
            input.manifest.datasetFingerprint,
          ),
        }
      : {}),
    resolvedVariants: input.manifest.resolvedVariants,
    effectiveConfig: input.manifest.effectiveConfig,
    ...(input.manifest.plannedSlotKeys
      ? { plannedSlotKeys: input.manifest.plannedSlotKeys }
      : {}),
    expectedSlotKeys: [...input.manifest.expectedSlotKeys].sort(),
    files: {
      "results.jsonl": textDigest(lines),
      "summary.json": textDigest(summaryText),
      "summary.md": textDigest(markdownText),
    },
  });
  await writeFile(
    join(resultDir, "manifest.json"),
    `${JSON.stringify(artifactManifest, null, 2)}\n`,
    "utf8",
  );
  return resultDir;
}

export async function verifyResult(resultDirInput: string): Promise<{
  ok: true;
  runId: string;
  episodes: number;
  digest: string;
  gatesPassed: boolean;
}> {
  const resultDir = resolve(resultDirInput);
  const manifestText = await readFile(join(resultDir, "manifest.json"), "utf8");
  if (Buffer.byteLength(manifestText) > MAX_CHECKED_ARTIFACT_BYTES) {
    throw new Error("manifest.json exceeds the checked-in artifact size limit");
  }
  if (SECRET_SHAPE.test(manifestText)) {
    throw new Error("manifest.json contains a secret-shaped value");
  }
  const rawManifest: unknown = JSON.parse(manifestText);
  assertNoLiteralCredentials(rawManifest, "manifest.json");
  const manifest = ResultManifestSchema.parse(rawManifest);
  const allowed = new Set(["manifest.json", "results.jsonl", "summary.json", "summary.md"]);
  const extras = (await readdir(resultDir)).filter((name) => !allowed.has(name));
  if (extras.length) throw new Error(`unexpected result artifacts: ${extras.join(", ")}`);
  const files = manifest.files;
  for (const name of ["results.jsonl", "summary.json", "summary.md"] as const) {
    const text = await readFile(join(resultDir, name), "utf8");
    if (Buffer.byteLength(text) > MAX_CHECKED_ARTIFACT_BYTES) {
      throw new Error(`${name} exceeds the checked-in artifact size limit`);
    }
    if (SECRET_SHAPE.test(text)) throw new Error(`${name} contains a secret-shaped value`);
    if (files[name] !== textDigest(text)) throw new Error(`${name} digest mismatch`);
  }
  const lines = (await readFile(join(resultDir, "results.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => ResultLineSchema.parse(JSON.parse(line)));
  const scored = lines.filter((line) => line.score !== undefined);
  if (
    scored.some(
      (line) =>
        line.score!.scorerDigest !== manifest.compatibility.scorerDigest,
    )
  ) {
    throw new Error(
      "result scorerDigest does not match compatibility metadata",
    );
  }
  if (
    manifest.rescore &&
    (manifest.rescore.scorerDigest !== manifest.compatibility.scorerDigest ||
      scored.some(
        (line) =>
          line.score!.scorerId !== manifest.rescore!.scorerId ||
          line.score!.scorerVersion !== manifest.rescore!.scorerVersion ||
          line.score!.scorerDigest !== manifest.rescore!.scorerDigest,
      ))
  ) {
    throw new Error("rescored result provenance does not match episode scores");
  }
  const slots = lines.map((line) => line.slotKey);
  if (new Set(slots).size !== slots.length) throw new Error("duplicate result slots");
  const expected = [...manifest.expectedSlotKeys].sort();
  const actual = [...slots].sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`result coverage mismatch: expected ${expected.length}, got ${actual.length}`);
  }
  const episodes = lines.map((line) =>
    EpisodeSchema.parse({
      schemaVersion: "openneko.eval.episode/v1",
      runId: line.runId,
      slotKey: line.slotKey,
      ...(line.pairKey ? { pairKey: line.pairKey } : {}),
      ...(line.treatment ? { treatment: line.treatment } : {}),
      caseId: line.caseId,
      caseContentId: line.caseContentId,
      family: line.family,
      productPath: line.productPath,
      difficulty: line.difficulty,
      capabilityTags: line.capabilityTags,
      semantics: line.semantics,
      variantId: line.variantId,
      datasetId: line.datasetId,
      repetition: line.repetition,
      phase: line.phase,
      attempt: line.attempt,
      startedAt: line.startedAt,
      finishedAt: line.finishedAt,
      status: line.status,
      measurements: line.measurements ?? {},
      observations: [],
      ...(line.score ? { score: line.score } : {}),
      ...(line.errorType ? { errorType: line.errorType } : {}),
      ...(line.error ? { error: line.error } : {}),
      integrityDigest: line.episodeDigest,
    }),
  );
  const recomputed = SummarySchema.parse(summarizeEpisodes(episodes));
  const storedSummary = SummarySchema.parse(
    JSON.parse(await readFile(join(resultDir, "summary.json"), "utf8")),
  );
  if (contentDigest(recomputed) !== contentDigest(storedSummary)) {
    throw new Error("summary does not match deterministic aggregate of results.jsonl");
  }
  const gatesPassed = evaluateSuiteGates(recomputed, manifest.suiteGates);
  if (manifest.accepted !== undefined && manifest.accepted !== gatesPassed) {
    throw new Error("result acceptance does not match deterministic suite gates");
  }
  return {
    ok: true,
    runId: manifest.runId,
    episodes: lines.length,
    digest: textDigest(manifestText),
    gatesPassed,
  };
}

export async function readStateEpisodes(
  stateRoot: string,
  manifest: EvalManifest,
): Promise<EvalEpisode[]> {
  const episodesDir = join(resolve(stateRoot), "runs", manifest.runId, "episodes");
  const entries = await readdir(episodesDir);
  const episodes: EvalEpisode[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    episodes.push(EpisodeSchema.parse(JSON.parse(await readFile(join(episodesDir, entry), "utf8"))));
  }
  return episodes;
}

export async function renderStoredReport(resultDir: string): Promise<string> {
  return readFile(join(resolve(resultDir), "summary.md"), "utf8");
}

export async function readRunManifest(
  stateRoot: string,
  runId: string,
): Promise<EvalManifest> {
  return ManifestSchema.parse(
    JSON.parse(
      await readFile(join(resolve(stateRoot), "runs", runId, "manifest.json"), "utf8"),
    ),
  );
}
