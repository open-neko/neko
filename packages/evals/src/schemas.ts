import { z } from "zod";

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, "must be a stable lowercase identifier");
const Version = z.string().min(1).max(64);
const EnvRef = z.string().regex(/^env:[A-Z][A-Z0-9_]*$/u);
const Duration = z.string().regex(/^\d+(?:ms|s|m|h)$/u);
const Ref = z.object({ ref: z.string().min(1) }).strict();

export const PricingCatalogSchema = z
  .object({
    schema_version: z.literal("openneko.eval.pricing/v1"),
    id: Id,
    version: Version,
    currency: z.literal("USD"),
    effective_date: z.string().date(),
    sources: z.array(z.string().url()).min(1),
    entries: z
      .array(
        z
          .object({
            provider: z.string().min(1),
            model: z.string().min(1),
            input_usd_per_million_tokens: z.number().nonnegative(),
            output_usd_per_million_tokens: z.number().nonnegative(),
            cache_read_usd_per_million_tokens: z.number().nonnegative().optional(),
            cache_write_usd_per_million_tokens: z.number().nonnegative().optional(),
            notes: z.string().max(1024).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ModelConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    credential_ref: EnvRef.optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const VariantSchema = z
  .object({
    id: Id,
    extends: Id.optional(),
    backend: z.literal("hermes"),
    outer_model: ModelConfigSchema,
    data_path: z.enum([
      "graphjin-direct",
      "graphjin-agent",
      "planner-host-execute",
      "none",
    ]),
    inner_model: ModelConfigSchema.optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const EvalConfigSchema = z
  .object({
    schema_version: z.literal("openneko.eval/v1"),
    id: Id,
    description: z.string().max(2048).optional(),
    adapter: Id,
    semantics: Ref.optional(),
    pricing: Ref.optional(),
    suite: Ref.extend({ cases: z.array(Id).min(1).optional() }).strict(),
    datasets: z
      .array(
        Ref.extend({
          snapshot: Id,
          settings: z.record(z.string(), z.unknown()).optional(),
        }).strict(),
      )
      .min(1),
    defaults: z
      .object({
        repetitions: z.number().int().min(1).max(100).default(1),
        timeout: Duration.default("10m"),
        execution_order: z
          .enum(["declared", "randomized", "counterbalanced"])
          .default("counterbalanced"),
        concurrency: z.number().int().min(1).max(100).default(1),
        cache_state: z.enum(["cold", "warm", "mixed"]).default("warm"),
        content_capture: z.enum(["off", "metadata", "redacted"]).default("metadata"),
        max_attempts: z.number().int().min(1).max(10).default(2),
      })
      .strict()
      .default({
        repetitions: 1,
        timeout: "10m",
        execution_order: "counterbalanced",
        concurrency: 1,
        cache_state: "warm",
        content_capture: "metadata",
        max_attempts: 2,
      }),
    variants: z.array(VariantSchema).min(1),
    budgets: z
      .object({
        max_wall_time: Duration.optional(),
        max_estimated_cost_usd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    artifacts: z
      .object({
        check_in: z.enum(["none", "scored"]).default("scored"),
        raw_dir: z.string().min(1).default(".openneko/evals/raw"),
        state_dir: z.string().min(1).default(".openneko/evals/state"),
        results_dir: z.string().min(1).default("evals/results"),
      })
      .strict()
      .default({
        check_in: "scored",
        raw_dir: ".openneko/evals/raw",
        state_dir: ".openneko/evals/state",
        results_dir: "evals/results",
      }),
  })
  .strict();

export const DatasetSchema = z
  .object({
    schema_version: z.literal("openneko.eval.dataset/v1"),
    id: Id,
    version: Version,
    description: z.string().max(4096).optional(),
    license: z.string().min(1),
    capabilities: z.array(Id).min(1),
    snapshots: z
      .array(
        z
          .object({
            id: Id,
            description: z.string().optional(),
            seed: z.number().int().optional(),
          })
          .strict(),
      )
      .min(1),
    connection: z
      .object({
        agent_graphql_ref: EnvRef.optional(),
        agent_mcp_ref: EnvRef.optional(),
        oracle_database_ref: EnvRef.optional(),
        defaults: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    anchor_policy: z
      .object({
        kind: z.enum(["fixed", "data-derived"]),
        value: z.string().optional(),
        description: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export const AssertionSchema = z
  .object({
    id: Id,
    dimension: z.enum(["ground_truth", "method", "behavior", "safety", "efficiency"]),
    kind: Id,
    gate: z.boolean().default(false),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const MetricQuestionInputSchema = z
  .object({
    question: z.string().trim().min(1).max(4096),
    role: z.enum(["CEO", "CFO", "COO", "CRO", "CMO", "CIO", "CPO"]),
  })
  .strict();

export const CaseSchema = z
  .object({
    schema_version: z.literal("openneko.eval.case/v1"),
    id: Id,
    version: Version,
    family: z.enum(["read", "watcher", "mutation", "resilience", "contract"]),
    product_path: Id,
    dataset: Id,
    capability_tags: z.array(Id).min(1),
    difficulty: Id,
    semantics: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z0-9][A-Z0-9._-]*$/u, "must be a stable semantic ID"),
      )
      .min(1),
    input: z.record(z.string(), z.unknown()),
    oracle: z
      .object({
        kind: Id,
        ref: z.string().min(1).optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    phases: z.array(Id).min(1).default(["initial"]),
    timeout: Duration.optional(),
    allowed_side_effects: z.array(Id).default([]),
    assertions: z.array(AssertionSchema).min(1),
  })
  .strict();

export const SuiteSchema = z
  .object({
    schema_version: z.literal("openneko.eval.suite/v1"),
    id: Id,
    version: Version,
    description: z.string().max(4096).optional(),
    cases: z.array(Ref).min(1),
    gates: z
      .object({
        min_macro_ground_truth: z.number().min(0).max(1).optional(),
        min_behavior: z.number().min(0).max(1).optional(),
        min_token_usage_coverage: z.number().min(0).max(1).optional(),
        require_safety: z.boolean().default(true),
      })
      .strict()
      .default({ require_safety: true }),
  })
  .strict();

export const SemanticRegistrySchema = z
  .object({
    schema_version: z.literal("openneko.eval.semantics/v1"),
    generated_from: z.string().min(1),
    entries: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[A-Z0-9][A-Z0-9._-]*$/u, "must be a stable semantic ID"),
            category: Id,
            description: z.string().min(1),
            verification: z.string().min(1),
            disposition: z.enum(["declared", "eval", "non-eval"]),
            owners: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const ScoreCheckSchema = z
  .object({
    assertionId: Id,
    dimension: z.enum(["ground_truth", "method", "behavior", "safety", "efficiency"]),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    gate: z.boolean(),
    diagnostic: z.string().max(1024).optional(),
  })
  .strict();

export const ScoreVectorSchema = z
  .object({
    groundTruth: z.number().min(0).max(1),
    method: z.number().min(0).max(1),
    behavior: z.number().min(0).max(1),
    safety: z.number().min(0).max(1),
    efficiency: z.number().min(0).max(1),
  })
  .strict();

export const ScoreCoverageSchema = z
  .object({
    groundTruth: z.boolean(),
    method: z.boolean(),
    behavior: z.boolean(),
    safety: z.boolean(),
    efficiency: z.boolean(),
  })
  .strict();

export const ScoreSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.score/v1"),
    scorerId: Id,
    scorerVersion: Version,
    scorerDigest: z.string().startsWith("sha256:"),
    verdict: z.enum(["pass", "fail"]),
    vector: ScoreVectorSchema,
    coverage: ScoreCoverageSchema,
    checks: z.array(ScoreCheckSchema),
  })
  .strict();

export const AttemptSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.attempt/v1"),
    runId: Id,
    slotKey: z.string().min(1),
    attempt: z.number().int().min(1),
    event: z.enum(["started", "finished"]),
    timestamp: z.string().datetime(),
    status: z.enum(["running", "completed", "failed", "environment_failure"]),
    errorType: z.string().max(128).optional(),
    error: z.string().max(2048).optional(),
  })
  .strict();

export const EpisodeSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.episode/v1"),
    runId: Id,
    slotKey: z.string().min(1),
    caseId: Id,
    caseContentId: z.string().startsWith("sha256:"),
    family: z.enum(["read", "watcher", "mutation", "resilience", "contract"]),
    productPath: Id,
    difficulty: Id,
    capabilityTags: z.array(Id),
    semantics: z.array(z.string()),
    variantId: Id,
    datasetId: Id,
    repetition: z.number().int().min(1),
    phase: Id,
    attempt: z.number().int().min(1),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(["completed", "failed", "environment_failure"]),
    output: z.unknown().optional(),
    measurements: z.record(z.string(), z.unknown()).default({}),
    observations: z.array(z.unknown()).default([]),
    score: ScoreSchema.optional(),
    errorType: z.string().max(128).optional(),
    error: z.string().max(2048).optional(),
    integrityDigest: z.string().startsWith("sha256:"),
  })
  .strict();

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.manifest/v1"),
    runnerVersion: Version,
    runId: Id,
    configId: Id,
    suiteId: Id,
    attestation: z.enum(["self-reported", "ci-attested"]),
    suiteGates: SuiteSchema.shape.gates,
    status: z.enum(["in_progress", "complete"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    source: z.object({
      commit: z.string().min(1),
      dirty: z.boolean(),
    }),
    compatibility: z.object({
      configDigest: z.string().startsWith("sha256:"),
      suiteDigest: z.string().startsWith("sha256:"),
      datasetDigest: z.string().startsWith("sha256:"),
      oracleDigest: z.string().startsWith("sha256:"),
      scorerDigest: z.string().startsWith("sha256:"),
      variantDigest: z.string().startsWith("sha256:"),
      sourceDigest: z.string().startsWith("sha256:"),
    }),
    resolvedVariants: z.record(z.string(), z.unknown()).default({}),
    effectiveConfig: EvalConfigSchema,
    expectedSlotKeys: z.array(z.string()),
    completedSlotKeys: z.array(z.string()),
    failedSlotKeys: z.array(z.string()),
    inFlightSlotKeys: z.array(z.string()),
    resultDir: z.string().optional(),
  })
  .strict();

export const OracleJournalSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.oracles/v1"),
    digest: z.string().startsWith("sha256:"),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

export const UsageSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.usage/v1"),
    scope: z.enum(["outer", "inner", "total"]),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    billedCostUsd: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    pricingCatalogVersion: Version.optional(),
    coverage: z.enum(["complete", "partial", "unavailable"]),
    missingReasons: z.array(z.string().max(512)).optional(),
  })
  .strict();

export const GeneratorSchema = z
  .object({
    schema_version: z.literal("openneko.eval.generator/v1"),
    id: Id,
    version: Version,
    dataset: Id,
    seed: z.number().int(),
    count: z.number().int().positive(),
    quotas: z
      .array(
        z
          .object({
            capability: Id,
            difficulty: Id.optional(),
            minimum: z.number().int().nonnegative(),
            maximum: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const SummaryGroupSchema = z
  .object({
    tasks: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
    vector: ScoreVectorSchema,
  })
  .strict();

const MeasurementAggregateSchema = z
  .object({
    count: z.number().int().nonnegative(),
    coverage: z.number().min(0).max(1),
    total: z.number().nonnegative(),
    mean: z.number().nonnegative().nullable(),
    p50: z.number().nonnegative().nullable(),
    p95: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
  })
  .strict();

export const SummarySchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.summary/v1"),
    expectedEpisodes: z.number().int().nonnegative(),
    scoredEpisodes: z.number().int().nonnegative(),
    executionFailures: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
    passedTasks: z.number().int().nonnegative(),
    taskPassRate: z.number().min(0).max(1),
    meanConsistency: z.number().min(0).max(1),
    macro: ScoreVectorSchema,
    micro: ScoreVectorSchema,
    coverage: z.object({
      groundTruth: z.number().min(0).max(1),
      method: z.number().min(0).max(1),
      behavior: z.number().min(0).max(1),
      safety: z.number().min(0).max(1),
      efficiency: z.number().min(0).max(1),
    }),
    measurements: z
      .object({
        wallDurationMs: MeasurementAggregateSchema,
        firstOutputMs: MeasurementAggregateSchema,
        inputTokens: MeasurementAggregateSchema,
        outputTokens: MeasurementAggregateSchema,
        cacheReadTokens: MeasurementAggregateSchema,
        cacheWriteTokens: MeasurementAggregateSchema,
        reasoningTokens: MeasurementAggregateSchema,
        totalTokens: MeasurementAggregateSchema,
        estimatedCostUsd: MeasurementAggregateSchema,
        billedCostUsd: MeasurementAggregateSchema,
        usageCoverage: z
          .object({
            completeEpisodes: z.number().int().nonnegative(),
            partialEpisodes: z.number().int().nonnegative(),
            unavailableEpisodes: z.number().int().nonnegative(),
            completeRate: z.number().min(0).max(1),
            availableRate: z.number().min(0).max(1),
          })
          .strict(),
        costCoverage: z
          .object({
            completeEpisodes: z.number().int().nonnegative(),
            partialEpisodes: z.number().int().nonnegative(),
            unavailableEpisodes: z.number().int().nonnegative(),
            completeRate: z.number().min(0).max(1),
            availableRate: z.number().min(0).max(1),
          })
          .strict(),
      })
      .strict(),
    macroGroundTruth95CI: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    safetyGateFailures: z.number().int().nonnegative(),
    behaviorGateFailures: z.number().int().nonnegative(),
    tasks: z.array(
      z.object({
        key: z.string().min(1),
        variantId: Id,
        caseId: Id,
        datasetId: Id,
        phase: Id,
        family: z.enum(["read", "watcher", "mutation", "resilience", "contract"]),
        productPath: Id,
        difficulty: Id,
        capabilityTags: z.array(Id),
        semantics: z.array(z.string().min(1)),
        repetitions: z.number().int().positive(),
        passes: z.number().int().nonnegative(),
        majorityPass: z.boolean(),
        consistency: z.number().min(0).max(1),
        vector: ScoreVectorSchema,
        passAtK: z.record(z.string(), z.number().min(0).max(1).nullable()),
        passPowerK: z.record(z.string(), z.number().min(0).max(1).nullable()),
      }),
    ),
    byDifficulty: z.record(z.string(), SummaryGroupSchema),
    byFamily: z.record(z.string(), SummaryGroupSchema),
    byCapability: z.record(z.string(), SummaryGroupSchema),
    bySemantic: z.record(z.string(), SummaryGroupSchema),
    byDataset: z.record(z.string(), SummaryGroupSchema),
    byProductPath: z.record(z.string(), SummaryGroupSchema),
    byVariant: z.record(z.string(), SummaryGroupSchema),
    failureTypes: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const ResultLineSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.result/v1"),
    runId: Id,
    slotKey: z.string().min(1),
    caseId: Id,
    caseContentId: z.string().startsWith("sha256:"),
    family: z.enum(["read", "watcher", "mutation", "resilience", "contract"]),
    productPath: Id,
    difficulty: Id,
    capabilityTags: z.array(Id),
    semantics: z.array(z.string()),
    variantId: Id,
    datasetId: Id,
    repetition: z.number().int().positive(),
    phase: Id,
    attempt: z.number().int().positive(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(["completed", "failed", "environment_failure"]),
    measurements: z.unknown(),
    score: ScoreSchema.optional(),
    errorType: z.string().max(128).optional(),
    error: z.string().max(2048).optional(),
    episodeDigest: z.string().startsWith("sha256:"),
  })
  .strict();

export const ResultManifestSchema = z
  .object({
    schemaVersion: z.literal("openneko.eval.result-manifest/v1"),
    runId: Id,
    configId: Id,
    suiteId: Id,
    attestation: z.enum(["self-reported", "ci-attested"]),
    suiteGates: SuiteSchema.shape.gates,
    sourceRunManifestDigest: z.string().startsWith("sha256:"),
    source: ManifestSchema.shape.source,
    compatibility: ManifestSchema.shape.compatibility,
    resolvedVariants: ManifestSchema.shape.resolvedVariants,
    effectiveConfig: EvalConfigSchema,
    expectedSlotKeys: z.array(z.string()),
    files: z.record(z.string(), z.string().startsWith("sha256:")),
  })
  .strict();

export type EvalConfig = z.infer<typeof EvalConfigSchema>;
export type PricingCatalog = z.infer<typeof PricingCatalogSchema>;
export type EvalVariant = z.infer<typeof VariantSchema>;
export type EvalDataset = z.infer<typeof DatasetSchema>;
export type EvalCase = z.infer<typeof CaseSchema>;
export type EvalSuite = z.infer<typeof SuiteSchema>;
export type SemanticRegistry = z.infer<typeof SemanticRegistrySchema>;
export type EvalScore = z.infer<typeof ScoreSchema>;
export type EvalAttempt = z.infer<typeof AttemptSchema>;
export type EvalEpisode = z.infer<typeof EpisodeSchema>;
export type EvalManifest = z.infer<typeof ManifestSchema>;
export type EvalOracleJournal = z.infer<typeof OracleJournalSchema>;
export type EvalUsage = z.infer<typeof UsageSchema>;
export type EvalGenerator = z.infer<typeof GeneratorSchema>;
export type EvalSummaryDocument = z.infer<typeof SummarySchema>;
export type EvalResultLine = z.infer<typeof ResultLineSchema>;
export type EvalResultManifest = z.infer<typeof ResultManifestSchema>;
