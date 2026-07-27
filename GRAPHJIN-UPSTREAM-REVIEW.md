# GraphJin agent-memory features — what OpenNeko already has, and what's worth taking

Review of the GraphJin 3.19.x/3.20.0 "agent memory" wave (declared tasks, work
trails, warm starts, task-linked watches, verified outcomes) against what
OpenNeko ships today.

**Bottom line:** seven of the nine announced items OpenNeko already implements,
in most cases with a stronger security and durability story. One is a real gap
worth building (**verified outcomes**), one is an architectural decision to make
(**catalog-level learnings**), and the most urgent practical item isn't on the
list at all: **we're pinned to GraphJin 3.18.42 while upstream is at 3.20.0**,
and 3.19.2 shipped a watch/subscription wave that overlaps our own watcher
implementation.

---

## Where we are relative to upstream

`packages/llm/src/graphjin/version.ts:4` pins `GRAPHJIN_VERSION = "3.18.42"`.
Upstream released:

| Version | Date | Relevant content |
|---|---|---|
| 3.19.1 | 2026-07-20 | — |
| 3.19.2 | 2026-07-25 | capability-filtered skills and watch flows; system-root subscriptions; guarded watch event subscriptions; "reactive watch automation wave one"; unified watch review + action approval |
| 3.19.3 | 2026-07-26 | **durable declared tasks** (`gj_task`, `gj_task_entry`); **verify declared task outcomes** |
| 3.20.0 | 2026-07-27 | governed catalog annotations |

Note the shape of 3.19.2 and 3.20.0: GraphJin is building *upward* into the
layer OpenNeko occupies — watch → review → approval, and annotated catalogs.
That is worth tracking deliberately, because two implementations of the same
loop in the same stack is a maintenance tax, not a feature.

Also relevant to how much this affects us: OpenNeko currently calls the GraphJin
server agent in exactly one place — the admin-only source-config advisory path
(`packages/llm/src/work/control-plane.ts:935-988`), gated on
`agentStatus.read_only`. The main agent loop shells to `graphjin cli` behind the
guard (`packages/llm/src/work/graphjin-guard.ts`), it does not call
`ask_graphjin_agent`. So GraphJin-side agent memory only reaches our runtime if
we deliberately wire it in.

---

## Item-by-item

### 1. Declared tasks (`gj_task`) — partially have it; the missing piece is small but real

GraphJin: an explicit, durable, owner-scoped record — one sentence of intent,
status `open` / `verifying` / `closed`.

OpenNeko has two things in the neighbourhood:

- `workflow_definition` (`db/migrations/0009_workflows.sql`) carries a `goal`
  column, is durable, org-scoped, and owns its runs. This is the *recurring*
  goal.
- `work_thread` (`db/migrations/0006_work_runtime.sql`) is a durable
  conversation with a title and `backend_state`, and everything hangs off it.

What we don't have is a **cross-thread, cross-workflow unit of ad-hoc work with
a lifecycle**. "Investigate why supplier deliveries are slipping" today becomes
either a thread (dies with the conversation's relevance, no open/closed state)
or a workflow (wrong shape — it's not recurring, and it has no terminal state).
Nothing lets a finding on the briefing, three chat threads, a watcher, and two
approved actions declare themselves parts of the same investigation.

**Verdict:** genuine gap, but a modest one — it's a correlation object, and we
already have every entity it would correlate.

### 2. The work trail (`gj_task_entry`) — already have it, deeper

GraphJin's trail is an append-only entry list with provenance labels separating
server-recorded facts from agent-written claims.

Ours:

- `work_run` with `actor_user_id` + `actor_role` **snapshotted at run start**
  (`db/migrations/0031_actor_in_runs.sql`) — a later role change doesn't
  retro-affect a recorded turn.
- `work_run_event` — sequenced, per-run event stream with a unique
  `(run_id, seq)` index.
- `workflow_run` — `trigger_kind`, `trigger_payload`, `chain_depth`, `summary`.
- `action_request` / execution receipts — who authorised, on what basis.
- `audit_chain` (`db/migrations/0046_audit_chain.sql`) — per-org **hash chain**
  over governance transitions; any retroactive edit breaks every later link,
  and `verifyAuditChain` reports the first break.
- `work_memory.integrity_hmac` (`db/migrations/0041_memory_integrity_ttl.sql`) —
  readers drop rows whose HMAC no longer matches, i.e. DB-level tamper/poison
  detection on the memory rows themselves.

Agent-claimed vs. server-recorded is exactly our `work_pending_memory`
(`proposed`) vs. `work_memory` (accepted) split, plus the audit chain for facts.

**Verdict:** already implemented, and tamper-evident in a way GraphJin's trail
isn't. Nothing to take.

### 3. Warm starts — already have it, and already cross-vendor

`work_memory` (`db/migrations/0007_work_memory.sql`) is scoped
`global`/`thread`/`database`, has pgvector embeddings plus exact search,
confidence, pinning, use counts, and per-user overlay layers. `work_thread`
persists `backend_state`; `compact-transcript.ts` handles long history.

The cross-vendor claim ("Claude starts it, Codex can finish it") is already true
for us at a level GraphJin can't reach: memory is stored in *our* Postgres and
read by whichever backend runs the turn — `agent-backends/claude-agent.ts` and
`agent-backends/hermes.ts` both consume the same rows via
`agent-backend-resolver.ts`. Swapping providers doesn't move the memory.

**Verdict:** already implemented, at the right layer. GraphJin's version would
warm-start *GraphJin's* agent, which for us is one admin advisory path.

### 4. "A task id is a label, never a key" — already our design principle

We enforce the stronger version already: per-run actor JWTs minted at 5-minute
TTL (`packages/llm/src/graphjin/token.ts`), the live `app_user` role rechecked on
every config-agent call and again before apply, the CLI guard denylist blocking
every write subcommand plus mutations/subscriptions in executor payloads
(`graphjin-guard.ts`), and write grants only via an explicit enabled
`auto_approve` policy for an admin actor (`graphjin-actor-guard.ts`).

**Verdict:** already the architecture. The useful takeaway is a *safety
clearance*: if we do adopt task ids, GraphJin's contract says they carry no
authority, so passing one across the boundary doesn't widen our attack surface.

### 5. Watches that know why they exist — already have it

`watcher` (`db/migrations/0045_watchers.sql`) requires a `workflow_id` and
fires that workflow, which writes a `workflow_output` finding with a title,
body, severity, and time window, which in turn proposes actions through the
approval stack. The 3am alert already arrives with the workflow's `goal` and
`description` attached and a drafted next action.

**Verdict:** already implemented, and further along than GraphJin's version —
theirs attaches a reason, ours attaches a reason *and* a proposed action *and*
a receipt trail. The only thing missing is the link to an ad-hoc investigation
(item 1).

### 6. Verified outcomes — **this is the one to build**

GraphJin: closing a task can carry `verify_json` — a named saved query, optional
variables, a typed predicate (`empty`, `not_empty`, `count_le`, `count_ge`,
`eq`, `neq`, `le`, `ge`), and an optional one-shot recheck window. Runs under
the task owner's identity. Pass → closed-verified. Fail → stays open with a
`task_verify_failed` notice and a verification trail entry.

**We have nothing equivalent.** Our loop ends at *executed*: a finding is
raised, an action is proposed, a human approves, the plugin runs, a receipt is
written. Nothing ever re-reads the data to confirm the condition actually
cleared. `workflow_output` findings dedupe (`db/migrations/0044_output_dedupe.sql`,
`seen_count`) and can be muted, but they never *close*, and never close *with
proof*. `hours_saved` (`db/migrations/0024_hours_saved.sql`) estimates value; it
doesn't verify effect.

This is the highest-value item on the list and it lands squarely on OpenNeko's
positioning — "actions drafted, not auto-fired" becomes "actions drafted, fired
on approval, and *proven*."

The good news: **we already own every primitive.** A `watcher` row is literally
`query` + `value_path` + `op` + `threshold` — GraphJin's predicate engine, in
our schema, already scheduled by our sweep. A verification is a one-shot watcher
armed at action-execution time and evaluated once after a delay, writing its
result back onto the finding.

Rough shape:

- new columns on `workflow_output`: `resolution` (`open` / `verifying` /
  `verified` / `verify_failed`), `verify_spec jsonb`, `verified_at`,
  `verify_evidence jsonb`
- reuse the watcher evaluator for the predicate, so there's one condition
  language in the product, not two
- arm on `action_request` execution; the existing cron sweep does the recheck
- fail → the finding reopens with the observed value as evidence, which is
  already how we'd want a bad auto-approve to surface
- roll the pass rate into the at-a-glance stats strip — "% of closes verified"
  is a better trust number than anything currently on that strip

### 7. The audit answer — already have it

"What did the AI agents actually do in our database this week?" is answerable
today from `work_run` (with actor), `workflow_run`, `action_request` +
executions, and `audit_chain` — all in our own Postgres, all queryable, and the
assistant can answer it in chat because it's the same governed surface.

**Verdict:** already implemented. The one soft spot is presentation: there's no
single "agent activity this week" rollup view. Cheap to add once item 6 exists,
because *then* the rollup has the interesting number in it (verified fraction).

### 8. Nothing is hidden — already our thesis

Every entity above is a row in our Postgres behind our permissions, versioned
by config-VCS, with personal/team memory layers. This is the README's opening
argument, not a new idea for us.

### 9. "Coming next: the graph that learns" — **we already shipped this**

GraphJin's roadmap item is: agents figure things out about your data, drafts
stay private, a human approves what enters the shared map.

That is precisely `work_pending_memory` → `work_memory`
(`db/migrations/0007_work_memory.sql`): `proposed` / `accepted` / `declined`,
with `reasoning`, `conflict`, and `confidence` on the draft. Kinds include
`business_rule` and `metric_definition`; scope includes `database`; the
personal-vs-team overlay (`db/migrations/0037_memory_fork_overlay.sql`) and
promote/adopt give exactly the "drafts stay private, a human approves what
enters the shared map" behaviour. "Status 4 here actually means chargeback
pending" is a `business_rule` at `scope='database'` today.

**Verdict:** shipped, ahead of their roadmap.

The one thing they'd have that we don't is *where* the learning lives. GraphJin
3.20.0's "governed catalog annotations" pins it to the schema catalog, so every
consumer of that GraphJin sees it — not just OpenNeko. If a customer runs other
clients against the same GraphJin, that's real. If OpenNeko is the only
consumer, it's strictly worse for us: it moves our differentiator out of our
Postgres.

---

## The architectural catch, if we were tempted to adopt `gj_task` directly

GraphJin's tasks live in **its artifact SQL store** (SQLite by default, or an
`app` source for multi-replica), with `max_per_owner: 20`,
`max_entries_per_task: 500`, and `entry_retention_hours: 168` (7 days).

Two problems for us:

1. **It splits the memory layer.** README: "Apache-2.0 core, self-hosted, single
   Postgres. Take a backup, take it with you." Agent memory living partly in
   GraphJin's artifact store breaks that promise, and it's a promise we lead
   with.
2. **The retention defaults are wrong for our use case.** A 7-day trail window
   and 20 active tasks per owner suit an agent session store. Our findings,
   decisions, and receipts are audit records that outlive that by a lot.

So: take the **ideas** (verification predicates, task-as-correlation-object),
implement them in our Postgres against our existing entities. Don't federate
memory into GraphJin.

---

## Recommendation

1. **Build verified outcomes** (item 6). Real gap, high value, differentiating,
   and cheap because the watcher evaluator and cron sweep already exist. This
   is the one thing on the list we should genuinely want.
2. **Consider a lightweight investigation object** (item 1) — an ad-hoc
   `open`/`closed` unit that findings, threads, watchers, and action requests
   can point at. Only worth it if we're doing item 6, since "closed, verified"
   is what makes the object meaningful. Do it in our schema, not GraphJin's.
3. **Plan the 3.18.42 → 3.20.x upgrade separately from all of this.** Two minor
   versions of drift is the concrete risk on the table; sources-mode config
   behaviour has moved before (the 3.18.32 `GJ_DATABASE_*` hard-boot-error note
   in `db/graphjin/dev.sources.example.yml` is a reminder). Worth checking what
   3.19.2's watch/subscription wave means for our own watcher path before we
   invest further there.
4. **Skip items 2, 3, 4, 5, 7, 8, 9** — we have them, and in most cases the
   OpenNeko implementation is the stronger one. Item 9 in particular is worth
   noting internally: their roadmap item is our shipped feature.
5. **Watch the direction of travel.** 3.19.2 (watch → review → approval) and
   3.20.0 (governed catalog annotations) are GraphJin moving into OpenNeko's
   lane. Not urgent, but it should inform how much of our loop we want to keep
   coupled to a GraphJin we don't control.
