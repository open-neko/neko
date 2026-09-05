import { shortDigest } from "./canonical";
import type { LoadedCase, LoadedEval } from "./load";
import type { EvalDataset, EvalVariant } from "./schemas";

export type EvalSlot = {
  key: string;
  /** Candidate-neutral identity used to match backend and ablation episodes. */
  pairKey: string;
  treatment: string;
  suiteId: string;
  datasetId: string;
  variantId: string;
  caseId: string;
  repetition: number;
  phase: string;
  case: LoadedCase;
  dataset: EvalDataset;
  variant: EvalVariant;
};

export type EvalPlan = {
  schemaVersion: "openneko.eval.plan/v1";
  configId: string;
  suiteId: string;
  adapter: string;
  repetitions: number;
  calls: number;
  slots: readonly EvalSlot[];
  skipped: readonly { caseId: string; variantId: string; reason: string }[];
  estimatedMaxCostUsd?: number;
};

type SlotIdentity = Pick<
  EvalSlot,
  "suiteId" | "datasetId" | "variantId" | "caseId" | "repetition" | "phase"
>;

function stableSlotKey(input: SlotIdentity): string {
  return [
    input.suiteId,
    input.datasetId,
    input.variantId,
    input.caseId,
    String(input.repetition),
    input.phase,
  ].join("/");
}

function stablePairKey(input: {
  suiteId: string;
  datasetId: string;
  pairId: string;
  repetition: number;
  phase: string;
}): string {
  return [
    input.suiteId,
    input.datasetId,
    input.pairId,
    String(input.repetition),
    input.phase,
  ].join("/");
}

function randomized(slots: EvalSlot[], seed: string): EvalSlot[] {
  return [...slots].sort((left, right) => {
    const a = shortDigest(`${seed}/${left.key}`);
    const b = shortDigest(`${seed}/${right.key}`);
    return a.localeCompare(b) || left.key.localeCompare(right.key);
  });
}

function counterbalanced(slots: EvalSlot[], variants: readonly EvalVariant[]): EvalSlot[] {
  const variantIndex = new Map(variants.map((variant, index) => [variant.id, index]));
  return [...slots].sort((left, right) => {
    const leftGroup = `${left.caseId}/${left.repetition}/${left.phase}`;
    const rightGroup = `${right.caseId}/${right.repetition}/${right.phase}`;
    const groupOrder =
      shortDigest(leftGroup).localeCompare(shortDigest(rightGroup)) ||
      leftGroup.localeCompare(rightGroup);
    if (groupOrder !== 0) return groupOrder;
    const count = Math.max(variants.length, 1);
    const offset =
      (Number.parseInt(shortDigest(left.caseId).slice(0, 8), 16) +
        left.repetition -
        1) %
      count;
    const leftPosition = ((variantIndex.get(left.variantId) ?? 0) - offset + count) % count;
    const rightPosition = ((variantIndex.get(right.variantId) ?? 0) - offset + count) % count;
    return leftPosition - rightPosition || left.key.localeCompare(right.key);
  });
}

export function createEvalPlan(loaded: LoadedEval): EvalPlan {
  const slots: EvalSlot[] = [];
  const skipped: Array<{ caseId: string; variantId: string; reason: string }> = [];
  for (const evalCase of loaded.cases) {
    const dataset = loaded.datasets.get(evalCase.dataset);
    if (!dataset) throw new Error(`dataset ${evalCase.dataset} was not loaded`);
    const missing = evalCase.capability_tags.filter(
      (capability) => !dataset.capabilities.includes(capability),
    );
    for (const variant of loaded.config.variants) {
      if (missing.length) {
        skipped.push({
          caseId: evalCase.id,
          variantId: variant.id,
          reason: `dataset lacks capabilities: ${missing.join(", ")}`,
        });
        continue;
      }
      for (
        let repetition = 1;
        repetition <= loaded.config.defaults.repetitions;
        repetition += 1
      ) {
        for (const phase of evalCase.phases) {
          const identity = {
            suiteId: loaded.suite.id,
            datasetId: dataset.id,
            variantId: variant.id,
            caseId: evalCase.id,
            repetition,
            phase,
          };
          slots.push({
            ...identity,
            key: stableSlotKey(identity),
            pairKey: stablePairKey({
              suiteId: loaded.suite.id,
              datasetId: dataset.id,
              pairId: evalCase.comparison?.pair_id ?? evalCase.id,
              repetition,
              phase,
            }),
            treatment: evalCase.comparison?.treatment ?? "default",
            case: evalCase,
            dataset,
            variant,
          });
        }
      }
    }
  }
  const ordered =
    loaded.config.defaults.execution_order === "declared"
      ? slots
      : loaded.config.defaults.execution_order === "randomized"
        ? randomized(slots, loaded.digests.config)
        : counterbalanced(slots, loaded.config.variants);
  return {
    schemaVersion: "openneko.eval.plan/v1",
    configId: loaded.config.id,
    suiteId: loaded.suite.id,
    adapter: loaded.config.adapter,
    repetitions: loaded.config.defaults.repetitions,
    calls: ordered.length,
    slots: ordered,
    skipped,
    ...(loaded.config.budgets?.max_estimated_cost_usd !== undefined
      ? { estimatedMaxCostUsd: loaded.config.budgets.max_estimated_cost_usd }
      : {}),
  };
}
