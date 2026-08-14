# Ground truth for whole-harness evaluation

OpenNeko is a harness — it observes data, understands it, decides, and acts —
so its evals cannot stop at "the agent answered a database question
correctly". This document defines how ground truth is established for every
capability layer, including the ones that have no single right answer text:
workflow builds that use skills, metric cards and dashboards, event-driven
actions, and composed observe→understand→decide→act (OUDA) episodes.

The governing principle, already implemented by the metric and lifecycle
adapters: **ground truth is constructed, not transcribed.** A case does not
store the correct output; it constructs a situation whose correct observable
outcome is computable by the host before or independent of any model call.
The `EvalDriver.resolveOracle` contract returns an arbitrary value, so an
oracle can be a number, an expected state machine, an event sequence, an
artifact digest, or a set of invariants. `pnpm openneko eval oracles --config
<path>` resolves and prints them for any config without provider traffic.

## 1. The four oracle families

### 1.1 Value oracles — observe and understand (implemented)

Hidden host-only SQL runs over the same immutable snapshot the agent queries
(`sql.metric`, `evals/datasets/adventureworks/oracles/`). The model never
sees the SQL; assertions compare its answer against resolved values, windows,
and winning dimensions. This family scales through corpus growth (q01–q40
today) and later a deterministic catalog-aware generator.

### 1.2 Contract oracles — metric cards and dashboards

A dashboard is numbers *plus* a renderable contract. Ground truth splits:

- **Numbers**: the same value-oracle family, extended with an ordered-series
  kind (`sql.series`) that resolves every chart point host-side — grain,
  point count, gap handling, comparison series (`CALC-SERIES`).
- **Contract**: deterministic validators over the produced card/A2UI payload —
  schema validity, chart hint consistency with the derived grain, evidence
  and freshness fields present and in agreement with the data
  (`OUTPUT-SURFACE`, `OUTPUT-VITALS`, `CALC-EVIDENCE`). The existing
  `metric.contract` assertion is the seed of this family.
- **Composition** (bootstrap/dashboard sets): deterministic checks for
  count/shape/role fit of the proposed metric set (`ONBOARD-BOOTSTRAP`),
  with each proposed metric individually re-resolvable against a value
  oracle — a proposed dashboard is *grounded* when every number on it can be
  reproduced by host SQL. Rubric judges may score usefulness, but never gate.

### 1.3 State-machine oracles — workflows, watchers, actions (implemented seed)

For decide/act behavior, the eval owns the environment, so the correct
outcome is known by construction:

- deterministic clock, seeded pre-state, injected source changes,
  in-memory/fake action adapters and receipts;
- ground truth = expected post-state, event sequence, delivery/debounce/
  dedupe/idempotency invariants, collateral-unchanged diffs, and audit-chain
  validity — expressed today as `inline.expected` boolean paths in the
  `openneko-control-plane` pack (w01/w02/a01/a02) and scored without any
  model call.

The model-in-the-loop extension keeps the same oracles: a case gives the
model a natural-language request ("watch inventory for spikes and open a
ticket when it fires"), the model builds the watcher/workflow/action through
the real product path, and then the **harness executes the resulting
definition deterministically** — tick the clock, inject the matching and
non-matching changes — and verifies observed behavior against the same
host-computed expectation. Correctness is behavioral equivalence, not
definition-text similarity: any definition that fires exactly on the
matching change, delivers once, executes the approved action once, and
leaves collateral untouched, passes (`FLOW-BUILD`, `WATCH-BUILD`,
`FLOW-RULE-BUILD` + the executable `WATCH-*`/`ACTION-*` matrix).

### 1.4 Artifact and method oracles — memory, skills, complex work

Tasks that use memory and skills produce verifiable effects even when their
prose is open-ended:

- **Outcome**: file/artifact digests and safe naming (`OUTPUT-ARTIFACT`),
  persisted DB state, or a value-oracle-checkable number inside the result.
- **Retrieval ground truth by construction**: seed the memory corpus so the
  relevant/irrelevant partition is known (`WORK-MEMORY-SEARCH`); a case
  plants the fact the task needs (and decoys it must not use) and asserts
  the answer used the planted fact — checkable as a value assertion.
- **Method**: the typed observation stream records tool, skill, delegation,
  and memory operations; method assertions check the path — the required
  skill was discovered and invoked, memory was searched before answering,
  aggregation happened in the database rather than over a truncated page
  (`WORK-SKILLS`, `DATA-PAGINATION`) — without parsing prose.
- **Safety**: scope/policy gates from the same stream (`SEC-*`).

Rubric judges remain last-resort, versioned, and non-gating (§6 of the
plan in `README.md`).

## 2. Composed OUDA episodes

Whole-loop cases chain the families through the existing multi-phase slot
model (`phases`, already used by watcher cases):

| Phase | Capability | Oracle family |
|---|---|---|
| observe | source/catalog discovery, freshness | value + method |
| understand | metric/profile/answer correctness | value + contract |
| decide | watcher threshold, policy, approval routing | state-machine |
| act | workflow run, action execution, delivery | state-machine + artifact |

Each phase records its own oracle results; the episode score vector keeps
`ground_truth`, `method`, `behavior`, `safety`, and `efficiency` separate, so
a correct number obtained with a wrong action (or vice versa) can never
average into a pass. Negative controls (non-matching change does not fire; a
denied policy is not bypassed) are first-class phases, not afterthoughts.

## 3. Suite roadmap

| Suite | Capability under test | Adapter work | Oracle kinds |
|---|---|---|---|
| `adventureworks-metric-40q` (shipped) | observe+understand: grounded metrics | none | `sql.metric` |
| `metric-series-cards` | dashboards: series + card contract | extend metric adapter with `sql.series` resolution and card-contract scoring | `sql.series`, contract |
| `bootstrap-dashboard` | propose a grounded exec dashboard | run bootstrap product path; re-resolve each proposed metric | contract + value re-resolution |
| `work-memory-skills` | complex `/work` tasks using seeded memory and skills | `/work` adapter with seeded memory corpus, skill catalog, artifact capture | value, artifact, method |
| `flow-build-exec` | NL workflow/watcher/rule build, then deterministic execution | lifecycle adapter gains a model-driven build phase before its existing executable matrix | state-machine |
| `event-driven-actions` | watcher→workflow→action chains with negative controls and approval governance | compose lifecycle scenarios; fake adapters and receipts | state-machine + audit |
| `ouda-e2e` | full loop on one business scenario | orchestration of the above | all four |

Sequencing follows the same rule that got the metric suite shipped: each
suite lands only with a host-resolvable oracle, a `plan`/`oracles` path that
needs no credentials, and gates that cannot be averaged away.

## 4. What this means for demo/VM-extracted truth

A live deployment (for example the public demo) is a *moving* dataset — its
simulator advances the data, so extracted values go stale. Ground truth is
therefore always resolved at run time against the same snapshot the agent
sees (the runner resolves all read-only oracles before provider traffic and
refuses to resume when oracle values changed). Extracting values from a live
system is useful for authoring sanity checks — `eval oracles` exists exactly
for that — but never as a stored answer key.
