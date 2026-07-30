# GraphJin Server-Agent Data Path: 20-Question Evaluation

- Date: 2026-07-30
- Branch: `spike/graphjin-agent-data-path`
- GraphJin source: `auth/v3.20.3`
- Outer backend: Hermes with `gemini-3.6-flash`
- GraphJin inner agent: `gemini-3.6-flash`
- Claude: intentionally excluded

## Executive summary

OpenNeko's direct, brokered GraphQL path was more accurate and substantially
faster than delegating the same data questions to GraphJin's built-in server
agent.

The direct path answered all 20 questions correctly. The GraphJin-agent path
answered 14 of 20 correctly under the composite scoring rule, returned one
execution timeout, and took 2.67 times as long in aggregate. Captured token
totals were approximately tied, but the GraphJin-agent total is a lower bound
because its timeout did not report outer Hermes usage.

The current result does not support replacing OpenNeko's direct GraphQL/CLI
data path with the embedded GraphJin agent. A more promising role is to use the
server agent for catalog discovery and query planning, then execute and verify
its proposed query through OpenNeko's deterministic broker.

## Experiment design

Each question was asked through two Hermes data-access arms:

- **Direct:** Hermes discovered the schema, wrote GraphQL, and called
  `mcp__neko_graphjin__execute_graphql`.
- **GraphJin agent:** Hermes delegated the complete data goal through
  `mcp__neko_graphjin_agent__ask`; GraphJin's read-only server agent performed
  discovery and execution.

Both arms used the same:

- outer Hermes model and OpenShell sandbox;
- AdventureWorks PostgreSQL database;
- metric output contract;
- live, database-derived ground truth;
- role, title, rationale, and chart request for each question.

The only intended treatment difference was the data-access mechanism. The
GraphJin server agent ran read-only with a 60-second inner timeout and six
maximum inner steps per request.

The 20 questions covered:

- six filters and date windows;
- seven aggregates, averages, distinct counts, and ratios;
- five header-detail joins;
- two grouped rankings that also required the winning dimension.

Ground truth was calculated on the host with SQL that was not exposed to either
arm. Question definitions and SQL live in
`apps/worker/scripts/graphjin-agent-ab-cases.ts`.

### Scoring

An answer was counted correct only when it had:

1. a valid structured metric response;
2. no more than 1% numeric error;
3. the exact requested time-window grain, start date, and end date;
4. the correct winning dimension for ranked questions.

Exact numeric and exact structured-chart values were also retained separately.
This matters because a human-friendly headline such as `$49.48M` may be
slightly rounded while its `chartData` value remains precise.

## Aggregate results

| Metric | Direct | GraphJin agent |
|---|---:|---:|
| Composite accuracy | **20/20 (100%)** | **14/20 (70%)** |
| Execution completion | 20/20 | 19/20 |
| Numeric result within 1% | 20/20 | 15/20 |
| Correct time window | 20/20 | 16/20 |
| Correct ranked dimension | 2/2 | 1/2 |
| Exact structured value | 18/20 | 9/20 |
| Total wall time | **1,377.7s (22m 58s)** | **3,676.3s (61m 16s)** |
| Mean wall time/question | **68.9s** | **183.8s** |
| Median wall time/question | **71.0s** | **143.5s** |
| Captured total tokens | 5,296,487 | at least 5,271,440 |
| Mean captured tokens/question | 264,824 | at least 263,572 |

The agent was faster only on q06, by approximately 1.5 seconds.

### Token accounting

Direct tokens were all outer Hermes tokens:

- outer: 5,296,487;
- inner: none;
- total: 5,296,487.

GraphJin-agent tokens combined both model loops:

- outer Hermes: 2,928,322;
- inner GraphJin agent: 2,343,118;
- captured total: 5,271,440.

The apparent 0.47% agent token saving is not a reliable advantage. q16 timed
out without returning outer Hermes usage, so the treatment total is
incomplete. GraphJin startup and preflight usage were also excluded from both
the per-question and aggregate totals.

Wall time was end-to-end per question. It began before `runMetricAgent` and
ended after the final result, so it included knowledge loading, workspace and
sandbox setup, the outer Hermes loop, all inner GraphJin calls, tool execution,
validation, and retries. Container/image construction, GraphJin startup, and
the independent preflight were excluded as one-time infrastructure costs.

## Results by difficulty

| Difficulty | Direct | GraphJin agent |
|---|---:|---:|
| Filters/date windows | 6/6 | 5/6 |
| Aggregates/ratios | 7/7 | 5/7 |
| Header-detail joins | 5/5 | 4/5 |
| Grouped rankings | 2/2 | **0/2** |

## Per-question results

`Pass` means the composite scoring rule passed; it does not imply an exact
unrounded headline.

| ID | Question | Direct result | Direct time | Direct tokens | Agent result | Agent time | Agent tokens |
|---|---|---|---:|---:|---|---:|---:|
| q01 | TTM order count | Pass: 21,699 | 78.6s | 287,822 | Pass: 21,682 (0.078% low) | 249.2s | 338,029 |
| q02 | Orders on latest sales date | Pass: 17 | 37.7s | 134,502 | Pass: 17 | 132.1s | 242,396 |
| q03 | Latest 30-day order count | Pass: 25 | 58.9s | 248,430 | Pass: 25 | 154.9s | 201,151 |
| q04 | TTM gross sales billed | Pass: $49.48M | 82.7s | 352,660 | Pass: $49.48M | 238.1s | 395,372 |
| q05 | TTM average order value | Pass: $2,283 | 40.4s | 112,978 | Pass: $2,282.77 | 171.9s | 329,175 |
| q06 | TTM distinct purchasing customers | Pass: 17,047 | 87.1s | 409,701 | Pass: 17,018 (0.170% low) | 85.6s | 122,712 |
| q07 | TTM online-order count | Pass: 20,168 | 54.3s | 346,220 | **Fail:** wrong start date; 20,166 | 180.6s | 245,014 |
| q08 | TTM online-order share | Pass: 92.9% | 46.9s | 162,589 | Pass: 92.9% | 124.6s | 227,206 |
| q09 | TTM sales subtotal | Pass: $44.30M | 53.3s | 227,907 | **Fail:** stale 2014 anchor; $43.74M | 126.5s | 345,522 |
| q10 | TTM freight charges | Pass: $1.26M | 61.5s | 157,974 | **Fail:** 9.824% low; $1.14M | 281.1s | 290,802 |
| q11 | TTM units sold | Pass: 138,398 | 93.2s | 339,469 | Pass: 138,373 (0.018% low) | 384.1s | 779,727 |
| q12 | TTM distinct products sold | Pass: 202 | 72.1s | 318,018 | **Fail:** used prior window; 241 | 104.2s | 436,166 |
| q13 | TTM average lines/order | Pass: 3.44 | 76.4s | 322,570 | Pass: 3.44 | 77.2s | 104,084 |
| q14 | TTM discounted sales lines | Pass: 1,499 | 49.5s | 153,284 | Pass: 1,499 | 175.2s | 227,729 |
| q15 | Revenue from top territory | Pass: Southwest, $9.78M | 63.7s | 219,422 | **Fail:** Southwest but 72.503% low; $2.69M | 68.7s | 80,458 |
| q16 | Units for top product | Pass: Water Bottle - 30 oz., 5,820 | 91.2s | 434,059 | **Fail:** 540s Hermes budget exceeded | 548.4s | at least 28,495 |
| q17 | TTM purchase-order count | Pass: 3,048 | 70.1s | 172,393 | Pass: 3,048 | 253.5s | 499,303 |
| q18 | TTM purchase-order subtotal | Pass: $49.32M | 71.9s | 252,818 | Pass: $49.32M | 80.2s | 97,204 |
| q19 | TTM rejected purchase units | Pass: 35,941 | 103.3s | 346,550 | Pass: 35,941 | 130.6s | 134,227 |
| q20 | TTM manufacturing work orders | Pass: 35,829 | 84.8s | 297,121 | Pass: 35,829 | 109.5s | 146,668 |

## Observed GraphJin-agent failure modes

### Date and anchor errors

- q07 used `2025-07-23` instead of the required `2025-07-24` start.
- q09 selected the stale AdventureWorks-era 2014 maximum date instead of the
  live 2026 maximum.
- q12 used a one-year-old anchor and returned the true prior-window value as
  the current value.
- q01 passed the 1% threshold but missed exactly the 17 orders on the inclusive
  anchor date.

### Incomplete aggregation

- q10 reported the correct window but undercounted freight by 9.824%.
- q15 found the correct `Southwest` dimension and prior-period value but
  undercounted current revenue by 72.503%.
- q06 and q11 passed the tolerance but were not exact.

These errors indicate that a plausible explanation and correct-looking time
window do not guarantee that the delegated aggregate is complete.

### Runaway delegation

q16 exceeded the 540-second Hermes turn budget after 11 delegated tool calls.
It produced 552,219 characters of tool output before termination. Only 28,495
inner tokens were reported; outer usage was unavailable.

## Where delegation helped

The agent path had meaningful token savings on several correct answers:

| Question | Direct tokens | Agent tokens | Latency observation |
|---|---:|---:|---|
| q06 distinct customers | 409,701 | 122,712 | Agent 1.5s faster |
| q13 average lines/order | 322,570 | 104,084 | Approximately equal |
| q18 purchasing subtotal | 252,818 | 97,204 | Agent 8.2s slower |
| q19 rejected units | 346,550 | 134,227 | Agent 27.4s slower |
| q20 work-order count | 297,121 | 146,668 | Agent 24.7s slower |

Across the whole suite, however, large overruns such as q11 and q17 erased
those savings. Nine questions showed lower captured agent tokens, but three of
those nine were incorrect or failed.

## Fairness and limitations

This was a fair product-path comparison, but not a publication-grade
statistical evaluation.

Strengths:

- identical outer backend, database, output contract, and ground truth;
- end-to-end outer and inner time included in each measured arm;
- successful inner usage added to outer usage instead of reporting only the
  GraphJin model;
- live ground truth for every question;
- raw output checkpointed after each arm;
- q17 direct rerun alone after its original run overlapped q16's late timeout.

Limitations:

- one stochastic sample per question;
- direct generally ran before agent rather than using randomized or
  counterbalanced order;
- q01 came from the prior clean run and q17 direct came from the isolated
  fairness rerun;
- the q16 outer token count is missing;
- inner and outer providers expose different usage schemas;
- cold image/container startup and the separate preflight were excluded;
- GraphJin's own repository warns that mini/flash-tier models may stall and
  recommends roughly GPT-4.1-class reasoning for agent evaluation.

The GraphJin preflight itself demonstrated the variance: it exhausted its
steps in the main run but passed in 60.3 seconds during the q17 fairness rerun.

The accuracy and latency differences are large enough to support the product
decision despite these limitations. The near-equal token total should not be
interpreted as proof of equal cost.

## Recommendation

Keep OpenNeko's direct GraphQL path as the default deterministic metric path.
Do not replace it with the current embedded GraphJin-agent execution loop.

If this integration is pursued, use the GraphJin server agent as a constrained
planner:

1. ask it to discover catalog IDs and propose compact GraphQL;
2. return the proposed query and evidence rather than a final number;
3. execute the query once through OpenNeko's existing broker;
4. enforce time-window boundaries in host code;
5. independently verify aggregates and ranked results.

Grouped rankings should remain direct-only until the agent can pass them
reliably. A follow-up evaluation should use a stronger inner model, run three
to five repetitions per question, counterbalance arm order, and capture usage
on timeouts.

## Reproduction and artifacts

The reusable command is:

```sh
pnpm test:e2e:graphjin-agent-ab
```

The runner requires Docker, OpenShell, Hermes, the local AdventureWorks
services, and an enabled OpenNeko Google Gemini provider. It builds an isolated
read-only GraphJin service, derives all ground truth, checkpoints results under
`.openneko/experiments/`, and removes the exact temporary container.

Relevant files:

- `apps/worker/scripts/graphjin-agent-ab-cases.ts`: question catalog and SQL
  ground truth;
- `apps/worker/scripts/graphjin-agent-ab.ts`: isolated service and experiment
  launcher;
- `apps/worker/test/e2e/graphjin-agent-ab.test.ts`: Hermes-only measurement,
  scoring, checkpointing, and summary;
- `.openneko/experiments/graphjin-agent-ab-20q-2026-07-30T12-22-06-158Z.json`:
  canonical local scratch artifact used to produce this report.

The raw JSON is intentionally generated and ignored rather than committed. It
contains full model outputs and diagnostic evidence; this Markdown document is
the stable, reviewable experiment record.
