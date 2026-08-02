# Resilience & Operations — Platform Baseline

**Scope:** every stateful thing an OpenNeko deployment ships — the metadata
Postgres, the config/secrets volume, GraphJin configuration, plugin state, and
(when the records engine lands, see [RECORDS_ENGINE.md](RECORDS_ENGINE.md) §6)
business-record data. OpenNeko's pitch is *the memory of how your business runs
stays on your infrastructure* — that promise is only as good as the durability
of that memory on a self-hosted, often single-host box that nobody is paid to
babysit. This document defines the platform posture; module plans (records
engine, future marketing/ERP) inherit it and add only their module-specific
pieces.

**Posture in one line:** crash safety is Postgres's and Docker's job; ours is
restart orchestration, idempotent side effects, backups that are *proven*
restorable, disk headroom management, honest degradation, and a deployment that
watches itself — with an HA ladder for those who need more than one host.

---

## 1. What state actually ships

The deployment is **not just a database**. A backup that captures `neko-db` but
not the config volume restores to a stack that cannot decrypt its secrets or
reach its sources.

| Store | Contents | Loss impact |
|---|---|---|
| `neko-db-data` volume | Findings, briefings, workflows + runs, work memory (+ embeddings), action requests / policies / decision history, hash-chained `audit_chain`, channel identities + dedup ledger, `data_source_secret` (enc:v1), pg-boss queues | **The business memory.** Unrecoverable by anything else. |
| `openneko-config` volume | `config.json` (incl. rotated DB passwords, deployment key material), `plugins.json` (installed-plugin manifest + policy snapshots), `secrets.json` (plugin env secrets, per-operator OAuth credentials, 0600) | **Equally fatal.** Without it: enc:v1 blobs in the DB are unreadable, every plugin credential and operator OAuth grant is gone, DB passwords are lost. |
| `openneko-graphjin-cli` volume | Durable GraphJin YAML (customer source definitions, `gjsecret://` refs, roles), managed file sources / OpenAPI assets | Sources must be manually reconfigured; managed file sources lost. |
| `openneko-agent-home` volume | Installed skills, agent home state | Cheap to rebuild but annoying; back up as a bonus, not a requirement. |
| `openneko-agent-tmp`, plugin VM work roots | Scratch; delta-sync checkpoints are the one exception (see module plans) | Disposable by design. |
| `records-db` volume (future) | Business records (CRM …) | Covered by RECORDS_ENGINE.md §6; folded into the same backup unit below. |
| Customer-owned sources (their Postgres, APIs) | Their data | **Out of scope** — OpenNeko reads it; the client owns its durability. Setup docs say so explicitly. |

**Consequence:** the platform *backup unit* is defined as
**{ all shipped Postgres databases } + { config volume } + { graphjin config
volume }**, captured coherently. Anything less is not a backup of an OpenNeko
deployment.

## 2. What already holds (and stays)

The stack is not starting from zero — these existing properties are load-bearing
and every future component must preserve them:

- **Restart orchestration:** every long-lived service runs
  `restart: unless-stopped` with healthchecks; dependents gate on
  `service_healthy`; migrations are one-shot jobs
  (`service_completed_successfully`). Web, worker, and GraphJin are stateless —
  a crash loses nothing in flight that isn't journaled elsewhere.
- **Durable, retried side effects:** action requests journal intent before
  execution; pg-boss retries with per-queue backoff (channel delivery: 8
  retries, exponential). Outbound messages are enqueued, never fired inline.
- **Exactly-once inbound:** the dedup ledger (canonical-JSON hashing,
  `ON CONFLICT DO NOTHING` claims), dead-lettering after repeated failure, and
  cursors that only advance when a whole batch settles.
- **Idempotent progress:** poll cursors, checkpointed job stages, `IF NOT
  EXISTS`-safe migrations.
- **Tamper-evident history:** the hash-chained `audit_chain`.
- **Secrets hygiene:** 0600 secrets file, enc:v1 at rest, egress-injected
  credentials that never enter sandboxes, optional Infisical vault
  ([SECRETS.md](SECRETS.md)).

## 3. The gaps this baseline closes

As of today the repo ships **no backup, no restore, no disk management, and no
self-monitoring of the substrate**. INSTALL.md and SECRETS.md contain zero
backup/restore guidance; "single Postgres — take a backup, take it with you"
(README) is an aspiration without a mechanism. For a product whose value *is*
accumulated memory, that's the biggest operational risk we ship. The rest of
this document is the plan to close it.

---

## 4. Platform baseline requirements

Every OpenNeko deployment gets these; every module inherits them.

### 4.1 Backups — verified, whole-deployment, on by default

- **Mechanism:** a `neko-backup` sidecar (pgBackRest) doing continuous WAL
  archiving + scheduled (default nightly) base backups of **every shipped
  Postgres** (`neko-db`, plus `records-db` when present), and — with each base
  backup — a snapshot tarball of the `openneko-config` and
  `openneko-graphjin-cli` volumes, so DB state and the key/config material that
  makes it usable restore as one coherent unit.
- **Targets:** local path / NAS mount by default; S3/GCS configurable at setup.
  Setup **warns loudly** when the target shares a failure domain with the data
  volumes. `--mode demo` may skip backups; `--mode prod` configures them in the
  wizard — an explicit "no backups" choice is allowed but recorded and nagged
  (briefing finding, `doctor` failure).
- **Key-material caveat, stated everywhere it matters:** a DB backup without
  the config snapshot is cryptographically dead (enc:v1). The restore path
  refuses a DB-only restore unless explicitly overridden.
- **RPO/RTO:** WAL archiving gives RPO of minutes; point-in-time recovery also
  covers human error ("restore to just before the bad change"). RTO is the
  runbook: tens of minutes on a fresh host.
- **CLI:** `openneko backup now|status`, `openneko restore --to <time>`
  (stop dependents → restore DBs → restore config snapshot → replay WAL →
  `doctor`). The full-host-loss drill — fresh host + backup target = working
  stack — is documented in INSTALL.md and exercised in CI.
- **Verification:** a weekly worker job restores the latest backup into a
  throwaway container, sanity-checks it (migration level, row counts against
  high-water marks, decryptability of one enc:v1 probe value using the
  snapshot's key material), and posts the result as a briefing finding.
  **An unverified backup is a hope, not a backup.** Staleness or failure is an
  alert, not a log line.

### 4.2 Disk headroom — watermarks and backpressure

- Each Postgres gets a **dedicated volume** (already true for `neko-db`;
  required for `records-db`) so usage is attributable and one runaway log can't
  starve a database. Postgres on ENOSPC PANICs but does not corrupt; recovery
  is free-space + restart — the goal is making that event rare and non-fatal.
- A worker sampler watches every shipped volume. **80%** — warning finding +
  channel alert. **90%** — deliberate degradation: pause bulk work (imports,
  delta syncs, embedding backfills, briefing regeneration), keep small
  interactive writes and reads alive. **95%** — hard stop on writes with an
  explicit banner. Recovery is automatic as space frees.
- Bulk operations everywhere adopt **pre-flight headroom checks** (estimate
  footprint, refuse with a concrete number rather than dying mid-way).
- Hygiene defaults shipped in config: `temp_file_limit`, WAL retention bounded
  by the archiver, autovacuum/bloat visibility in `openneko doctor` and
  `openneko status`.

### 4.3 Honest degradation

When a dependency is down, every surface says so rather than pretending:

- GraphJin or a data source unreachable → UI shows a degraded banner (no stale
  cache masquerading as live data); the agent reports "source unavailable"
  instead of reasoning around the hole; watchers record a skipped-run reason
  visible on the workflow.
- A database down → writes fail fast with typed errors; journaled intent
  (action requests, queued deliveries) survives and retries; approval cards
  never disappear.
- Channels down → outbound queues and retries (existing behavior); inbound
  webhook callers get retryable status codes.
- Every degradation state is *visible in one place* (`/settings` health panel +
  `openneko status`) so "why is it weird" has one answer.

### 4.4 Self-monitoring — the deployment watches itself

The watcher machinery clients point at their business data ships an **ops pack**
pointed at the substrate: disk headroom per volume, backup age and last
verification result, WAL-archive failures, container restart counts, pg-boss
queue depth / dead-letter growth, subscription-manager health, replication lag
(when Tier 1 below is in play), long-running job stalls. Findings land on the
Briefing; alerts go out through installed channels (Slack/Telegram). This
removes the defining self-hosted failure mode — *nobody was watching the box* —
and it's the dogfooding story: OpenNeko monitoring OpenNeko.

### 4.5 The HA ladder

Redundancy beyond one host is a deployment tier, not an application feature —
services only ever see connection strings:

- **Tier 0 (default, single host):** everything above. RPO minutes, RTO tens of
  minutes. The right answer for most deployments.
- **Tier 1 (warm standby):** async streaming replication of the shipped
  Postgreses to a second host + periodic config-volume sync; lag watched by the
  ops pack; **manual, documented promote runbook**. Automated failover
  (Patroni-class) is deliberately out of scope for a compose stack — easy to
  get dangerously wrong, and the failure it guards against is rarer than the
  split-brain it risks.
- **Tier 2 (BYO / managed Postgres):** point `neko-db` and/or `records-db` at
  RDS / Cloud SQL / a DBA-run cluster via connection config; skip the sidecar
  for externally-managed databases (their platform owns backup/HA — `doctor`
  checks reachability and warns that backup responsibility moved). The compose
  services are defaults, not requirements.

### 4.6 Data-lifecycle guards

- Uninstalling a plugin or archiving a records app **never drops data**;
  surfaces say "disabled/archived, data retained".
- Destructive operations (volume prune, restore-overwrite, hard delete, module
  drop) require typed confirmation **and** a fresh-verified-backup check.
- Deletes on business records are soft (recycle-bin semantics) per module
  plans; the metadata DB's history tables are append-only by convention and
  the audit chain makes tampering evident.

---

## 5. Per-surface summary

| Surface | Stance |
|---|---|
| web / worker / GraphJin containers | Stateless; restart policies + healthchecks; no additional work |
| `neko-db` | Backup unit member; dedicated volume (exists); watermarks; PITR |
| `records-db` (future) | Same, plus module specifics in RECORDS_ENGINE.md §6 |
| Config + secrets volumes | Snapshot with every base backup; restore refuses DB-only restores; Infisical option for orgs that want secrets out of the box entirely |
| Plugin sandboxes / VM work roots | Disposable; anything that must survive (sync checkpoints) is declared and either checkpointed to bind-mounted state or re-derivable |
| pg-boss queues | Live in `neko-db`, covered by its backup; dead-letter growth watched by ops pack |
| Agent home (skills) | Best-effort included in config snapshot; rebuildable |
| Customer-owned sources | Explicitly out of scope; documented as the client's responsibility |

## 6. Implementation plan

**R1 — Backup/restore core (ships with, or before, the first records-engine
release; independently valuable now):** `neko-backup` sidecar; config-volume
snapshotting; `openneko backup|restore` CLI; runbook in INSTALL.md; `doctor`
checks (backup configured, target reachable, last success age, key-material
presence); CI restore drill.

**R2 — Watch & degrade:** disk sampler + watermark backpressure hooks in the
worker; ops watcher pack + briefing/channel alerting; weekly restore
verification job; health panel + `openneko status` consolidation.

**R3 — HA tiers:** Tier 1 replication + promote runbook docs; Tier 2 external
connection strings for `neko-db` (records-db already plans this) with sidecar
skip + doctor handoff warnings.

Acceptance across R1–R2 (the platform bar every release then holds): CI runs a
kill/ENOSPC/restore matrix — kill each container mid-work and verify clean
resume; fill a test volume during bulk work and verify backpressure then
recovery; restore latest backup on a fresh stack and verify secrets decrypt,
sources reconnect, and the audit chain verifies.

---

*Feature plans (RECORDS_ENGINE.md and successors) reference this document and
specify only their feature-specific additions: pre-flight estimates for their
bulk operations, idempotency keys for their write paths, and any state they
place outside the shipped Postgreses.*
