import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AttemptSchema,
  CaseSchema,
  DatasetSchema,
  EpisodeSchema,
  EvalConfigSchema,
  ManifestSchema,
  GeneratorSchema,
  OracleJournalSchema,
  PricingCatalogSchema,
  ResultLineSchema,
  ResultManifestSchema,
  ScoreSchema,
  SemanticRegistrySchema,
  SummarySchema,
  SuiteSchema,
  UsageSchema,
} from "../src/schemas";

const outputDirectory = fileURLToPath(
  new URL("../../../evals/schemas/", import.meta.url),
);
const schemas = {
  "config.v1.schema.json": EvalConfigSchema,
  "dataset.v1.schema.json": DatasetSchema,
  "suite.v1.schema.json": SuiteSchema,
  "case.v1.schema.json": CaseSchema,
  "attempt.v1.schema.json": AttemptSchema,
  "episode.v1.schema.json": EpisodeSchema,
  "score.v1.schema.json": ScoreSchema,
  "manifest.v1.schema.json": ManifestSchema,
  "semantics.v1.schema.json": SemanticRegistrySchema,
  "oracles.v1.schema.json": OracleJournalSchema,
  "usage.v1.schema.json": UsageSchema,
  "pricing.v1.schema.json": PricingCatalogSchema,
  "generator.v1.schema.json": GeneratorSchema,
  "summary.v1.schema.json": SummarySchema,
  "result.v1.schema.json": ResultLineSchema,
  "result-manifest.v1.schema.json": ResultManifestSchema,
} as const;

await mkdir(outputDirectory, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const document = z.toJSONSchema(schema, { reused: "ref" });
  await writeFile(
    new URL(name, `file://${outputDirectory}/`),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}
