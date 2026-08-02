# Records Engine & Apps — Implementation Plan

**Scope:** a native OpenNeko records engine on which the **agent builds "apps"** —
a CRM is an app, a Zendesk-style support desk is an app, an inventory tracker is
an app. "Create an app that will let me bring in my Salesforce data" and "create
an app to help me replace Zendesk" are the product sentences this plan
implements. The agent designs the schema in conversation, GraphJin applies it
and serves the data — reads, writes, standing watches, and schema changes are
one GraphJin-governed data plane — the UI is generated from metadata, and
access follows the established user/role pattern.

Every app — however it was created — can **ingest CSVs as a baseline
capability** (D14): the schema comes from a conversation, the data usually
comes from a spreadsheet. Salesforce liberation (CSV export or connected
live-org import) is the first *connector-grade* feeder, not the product's
shape.

**Repo touched:** `open-neko/openneko` only. This is a native feature — **no
plugin** is involved (see D1). The `open-neko/plugins` repo needs no changes.

---

## 1. Philosophy

### 1.1 Free the data and the app follows

Clients don't stay on Salesforce or Zendesk because they like them; they stay
because their operational memory — accounts, deals, tickets, a decade of custom
objects — is held hostage inside them. OpenNeko's founding premise is that *the
intelligence is rented; the memory is yours*. This work extends that premise:
the system of record itself moves onto the client's infrastructure, in their own
Postgres, behind their own agent. Migration is not a feature of the app; the app
is the consequence of the migration — or of a conversation.

### 1.2 The agent is the app builder

There is no app store and no app SDK. A user-created app is **registry
content**: objects, fields, relationships, layouts, permissions — created and
evolved through the same propose → approve → execute → audit action stack every other OpenNeko
mutation uses. "Add a `warranty_expires` date to equipment" is an approval card,
not a migration PR. Starter **blueprints** (CRM, support desk, …) ship as data
the agent adapts in conversation, never as code paths. This is what makes the
roadmap (CRM → support → marketing → ERP) cheap: each next domain is a
conversation plus a feeder, not an engineering project.

From the user's perspective the loop is deliberately short: describe the app;
review a high-level object/field/relationship proposal with no SQL; approve;
GraphJin applies the projected schema while OpenNeko projects policy/config;
the app immediately appears with generated UI and CSV import. “I want to bring
my Zendesk data into OpenNeko” is this same loop plus a connector/import plan,
not a separate product flow.

### 1.3 Metadata over schema

No two businesses have the same shape — and no two Salesforce orgs do either.
**Nothing in the engine may hardcode a business schema.** Every screen,
validator, permission check, and agent affordance is generated from the metadata
registry. The engine only grows features a *current* app actually needs; domain
behavior (campaign sends, ERP postings) never enters the engine — it lands as
per-app automations built on the existing workflow machinery.

### 1.4 Chat-first writes, one write path, one audit trail

The primary create/update surface is chat: the agent proposes typed actions
through the action stack. Generated UI forms exist (an app must feel like a real
tool) but submit through the *same* action path, auto-approved because a human
filled the form. There is exactly one write path, one validation layer, one
change log — **and that now includes schema changes**, which are just another
action kind with a stricter safety profile (D6, D7).

### 1.5 One RBAC enforcement point

Reads — human UI, chat agent, watchers, subscriptions — all flow through
GraphJin running `auth: jwt` with per-actor short-lived tokens (the existing GJ4
mechanism). Role grants and row policies are *generated* from the same policy
tables the write executor checks. Access rules cannot drift between surfaces
because they have a single source of truth and two mechanical projections
(GraphJin config, write-path checks). Every app inherits this on creation for
free.

### 1.6 Native core; the sandbox is for third parties

The plugin sandbox exists to run **untrusted marketplace code** safely. The
records engine is first-party core — sandboxing it bought nothing but an
enable-switch plugin and an artificial split of the Salesforce connector across
a VM boundary. Dropped (D1). The plugin system is unaffected and remains the
boundary for third-party code; first-party connectors run in the worker like
every other first-party integration.

### 1.7 GraphJin is the data plane; the engine authors no SQL

Everything that touches business data goes through GraphJin: reads under
per-actor JWTs, writes as mutations under the worker's service role, standing
watches via `gj_watch`, and schema changes via GraphJin's declarative DDL and
diff engine. The engine never writes SQL against app data — what GraphJin's
surfaces can't express is designed around, not worked around. The one
engine-owned SQL surface is the `engine.*` substrate itself (registry
migrations and the per-table audit trigger installed at provisioning) —
substrate, not data path. This is what keeps enforcement, audit, and
observability in one place: there is no side channel for policy to miss.
Grounding for every claim about what GraphJin provides lives in
[RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md).

---

## 2. Decisions

Each decision records what was chosen, why, and what was rejected. This set
consolidates several revisions: the reversal of the plugin-based draft (D1,
D11), and the corrections that followed the GraphJin source audit
([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md)) — schema application via the
`graphjin db` CLI, table-prefix storage layout, Table-permissions RBAC,
GraphJin-mutation writes with trigger-based audit capture, and `gj_watch` as
the watch mechanism.

**D1 — Native core feature, not a plugin. (Reverses the earlier D1/D2.)**
The earlier draft shipped the engine dormant in core with a marketplace plugin
as the enable switch (the Scalekit pattern) plus sandboxed Salesforce
connectors. Once app creation is conversational, the switch is redundant — **an
app existing in the registry is the enable switch** — and the sandbox split
forced the connected import through a two-stage VM-work-root handoff for no
security gain on first-party code. Everything lands in `open-neko/openneko`:
engine, UI, adapters, connectors. *Rejected:* the `module` plugin capability;
`@open-neko/plugin-salesforce-crm`; any plugins-repo change.

**D2 — "App" is the unit; apps are agent-authored registry content.**
An app = a row in `engine.record_app` + its objects/fields/layouts/permissions
+ its prefixed table family in `records-db` (D4). Every app receives generated
UI + CSV import by default. Apps come into existence four ways, all converging
on the same schema executor (C3): (a) **conversation from scratch** — including
apps that have never been built before; blueprints are
priors, not limits, and the agent models a genuinely novel domain by
interviewing for entities, relationships, and workflows; (b) conversation from
a shipped blueprint the agent adapts; (c) derived from imported metadata
(Salesforce describe → proposed app) or a CSV's inferred shape (D14);
(d) **proposed by the agent on its own initiative** — when work memory shows a
recurring need (the user keeps asking for the same ad-hoc view, keeps tracking
the same list in chat), the agent surfaces an app proposal as a briefing
finding / chat suggestion. Self-initiated proposals are suggestions only:
nothing is created until a human approves the same `app_create` card every
other path uses. *Rejected:* apps as shipped code modules (predicting domains
instead of extracting them); a visual app-builder UI as the primary surface
(chat is the builder; admin UI edits come later and go through the same
actions); silent auto-creation of agent-proposed apps.

**D3 — Domain-neutral engine naming.**
Tables/adapters/routes say `record`/`app`, never `crm`: `record_object`,
`record_create` adapter, `/a/[app]` routes. "CRM" is the label of the first
app's registry rows, not an identifier in code.

**D4 — One dedicated business-data Postgres; apps as table-name prefixes.**
A new `records-db` compose service, fully separate from the neko metadata DB.
Inside it: schema `engine` (registry, change logs — created by our own
migrations) and app tables in the source's default schema named
`<app>__<object>` (`crm__account`, `support__ticket`). Per-app *Postgres
schemas* were the original design, but GraphJin's Postgres DDL generation
cannot schema-qualify (see [RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1) —
and the prefix is invisible anyway: every surface resolves names through the
registry (`record_object.table_name`), never by convention. Cross-app joins
stay ordinary SQL and GraphJin sees one database. *Rejected:* one Postgres per
app (federation tax); tables in the metadata DB (mixes operating loop with
business data, breaks the "take a backup, take it with you" story); per-app
Postgres schemas (unsupported by the DDL path that creates the tables).

**D5 — GraphJin is the whole data plane: reads, watches, and schema.**
`records-db` is served by the dedicated `records-graphjin` instance with JWT
auth. A metadata `data_source` row may register that endpoint for catalog and
health discovery, but does not author the standalone config. Chat runs already mint HS256 actor tokens
(`packages/llm/src/graphjin/token.ts`: `sub` = userId, `role` ∈
admin|member|service, 5-min TTL, per-org derived secret). The web UI's `/a/*`
pages mint the same tokens for the signed-in user — **no second SQL read path**.
Watching uses **`gj_watch`** — durable cursor-backed standing watches evaluated
under the owner's identity and role — with raw live-query subscriptions for UI
freshness only, and the existing scheduled-watch path as fallback (C12,
[RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §3). **Schema creation also goes
through GraphJin:** nobody on our side authors SQL for schema changes — not
the agent, not the executor. The C3 executor projects the registry into a
GraphJin DDL document (GraphQL-style `type` definitions,
`schema-ddl/*.ddl`) and drives GraphJin's schema-diff machinery, which
internally diffs against the live database, generates the SQL, and executes
it transactionally. At the pinned version the live invocation is the shipped
binary — `graphjin db diff` produces the technical SQL delta retained behind
the proposal, while the approval card presents the high-level app schema and
human-readable impact; `graphjin db sync --yes` applies it in one transaction with
rollback-on-error ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1; the
MCP/control-plane preview-apply surface is removed at this version). The
artifact of record is the GraphJin DDL document, live-catalog revision, diff
output, and their approved hash; the surrounding cross-database work is the C3
saga, not part of GraphJin's transaction.

**Records GraphJin configuration:** because `records-db` is our own built-in
database — not a customer's — it does **not** run `read_only`. It is
configured `analytics_mode: true` (no accidental implicit row limits; C5
instead supplies explicit per-query/role resource budgets) **plus
mutations- and DDL-capable** — `read_only` blocks all mutations and DDL, so
C3 requires it off. The single-write-path guarantee (D6) is enforced at the
**role level** instead of the source level, using GraphJin's first-class
**Table-permissions model** (`roles[].tables` — per role × per table ×
per operation with filters, column allowlists, presets, and blocks;
[RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §2), **machine-generated by
C7**: explicit `block: true` on mutations `admin`/`member` don't hold, row
filters like `{ owner_user_id: { eq: $user_id } }` on owner-visibility
tables, org-scoped grants/presets for `service`; role resolution via `roles_query`
against an engine-maintained actor table (`engine.actor`, synced from
`app_user`). Exhaustiveness is a security invariant: an omitted table means
unrestricted access for non-anon roles, so the generator introspects and emits
every live table × role × operation, always—including explicit blocks for
orphaned/archived/substrate tables. `service` credentials exist only in the worker
for the C3/C4 executors. One config-layout constraint applies: explicit
`roles[].tables` cannot share a config with `sources:` (per GraphJin's own
docs), so records runs apart from the customer-data source-mode config —
the dedicated `records-graphjin` instance, following the `neko-graphjin`
precedent. Customer
data sources are untouched: their source-mode analytics config keeps
`read_only: true` exactly as today. *Rejected:* direct SQL from Next.js API
routes (second enforcement point, guaranteed drift); hand-rolled DDL
generation in the engine (GraphJin already maintains the dialect + diff
engine); `read_only` on the records source (blocks the C3 apply path);
source-mode generated access rules for records (deliberately coarse —
anon/authenticated/admin tiers — while the Table-permissions model carries
the full D8 grant shape).

**D6 — All writes through core action adapters — data writes *and* schema
writes.**
Data: `record_create` / `record_update` / `record_delete` / `record_restore`. Schema: `app_create`
/ `app_object_create` / `app_field_add` / `app_field_modify` /
`app_object_archive` / `app_permission_set` / `app_layout_update` — all
registered with `registerActionAdapter` in the worker (the `user_admin` /
`data_source_admin` precedent in `apps/worker/src/plugins/manage-adapters.ts`).
Chat proposes → approval card → execute. UI forms create pre-approved requests
through the same executor. Every data write validates against the registry,
checks RBAC as the acting user, appends to `engine.record_change_log`, and
records into `workflow_run.source_writes` (migration `0021`) so watcher
cycle-checks keep working. Every schema write appends to
`engine.app_schema_log` with the submitted GraphJin DDL and preview response. The executors write
**through GraphJin mutations under the `service` role — never direct SQL**
([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §3): creates as insert
mutations, updates and soft-deletes as conditional `update` mutations, bulk
imports as batched array inserts. Atomic change-log capture comes from a
generic audit trigger installed on every app table at provisioning (part of
the `engine.*` substrate) — it writes `engine.record_change_log` from
OLD/NEW in the same transaction as the mutation, with actor and request
identity carried on the row (`nk_updated_by`, `nk_action_request_id`).
GraphJin is the entire data plane: reads, writes, watches, DDL.
*Rejected:* direct SQL in the write path (a second plane GraphJin can't
see); GraphJin mutations from agent- or user-facing roles (bypasses
approval cards and validation — blocked in-engine by the C7 role
projection); a separate "migration" pipeline for schema changes (two write
paths again).

**D7 — Schema evolution is additive-by-default; the agent can never destroy
data.**
The safety profile that makes agent-authored DDL acceptable: `api_name`s are
immutable (labels are freely editable — "rename" is a label change); adding
objects/fields is the normal path (`ask` mode); type changes are **always**
add-new-field + backfill + archive-old — never in-place (GraphJin's diff
engine generates no column alterations, by design and to our benefit);
"delete" of a field or object is **archive** (hidden from UI/agent surface,
column and data retained); hard drops exist only as an admin CLI command with
typed confirmation and a fresh-verified-backup check (per RESILIENCE.md §4.6).
All generated identifiers pass through one sanitizer (`naming.ts`), the single
security-sensitive chokepoint. *Rejected:* free-form DDL from the agent;
symmetric create/drop powers.

**D8 — RBAC v1: org roles + per-object grants + ownership row policies.**
`admin`/`member` from SSO groups (existing `app_user.role`), per-object CRUD
grants in `engine.record_permission` (seeded from a blueprint's defaults or
from Salesforce profiles at import), and a per-object visibility default
(`org` | `owner`) enforced as generated GraphJin row filters —
`{ owner_user_id: { eq: $user_id } }` for `member` on owner-visibility
objects; `admin` unfiltered (D5). **Explicitly deferred:** role hierarchy,
sharing rules, territories — the complexity clients are fleeing. Import
reports show exactly what collapsed. *Rejected for v1:* a faithful
Salesforce sharing-model port.

**D9 — Salesforce fidelity rules (for the SF feeder).**
18-char Salesforce IDs remain primary keys; every relationship survives
verbatim as an ID column. Formula and rollup fields are **materialized as
values** (the formulas die with Salesforce; the data survives) and marked
read-only in the registry. Compound fields flatten to columns. Legacy audit
columns (`CreatedById`, `CreatedDate`, `LastModifiedById`,
`LastModifiedDate`, `SystemModstamp`) are preserved read-only; new local audit
columns (`nk_created_*`, `nk_updated_*`) track post-migration writes. Binary
content (`ContentVersion` bodies) is out of v1 scope; rows import, blobs defer.

**D10 — User mapping by email, lazy, conflict-explicit.**
Imported user tables map to `app_user` on `lower(email)`, mirroring the
channel-identity pattern (`apps/worker/src/channels/identity.ts`): auto-link
matches, record non-matches as unlinked (they link lazily when that person
first signs in via SSO — same email key the auth plugin guarantees), surface a
mapping report. The host's SSO upsert keys on `sub` first and **fails closed**
on an email bound to a different `sub` (`apps/web/src/lib/auth.ts`,
`upsertUserFromIdentity`), so the report flags collisions rather than assuming
clean matches. Ownership columns carry both the source owner id (immutable) and
`owner_user_id` (mapped, nullable until linked).

**D11 — Importers and connectors run natively in the worker.
(Reverses the earlier D10/D13 sandbox split.)**
CSV loading is an hours-long batched pipeline (through GraphJin, per D6);
connected import needs a long-lived Salesforce Bulk API 2.0 client. Both are
first-party code and both now live in the worker as pg-boss jobs — no VM
work-root handoff, no 30s-RPC detached-job contortions. Credentials live in
`data_source_secret` (enc:v1) like every other source credential; outbound
hosts are declared per connector and surfaced in the approval card that
authorizes it (the worker already holds egress for LLM and channel traffic —
what changes is visibility, so we make the connector's destinations explicit).
The **artifact contract stays**: connectors stage
`export-manifest.json` + `describe/*.json` + `data/<object>.csv` into a
worker-owned staging directory, and the importer consumes that directory — so
the manual-CSV path and every future connector (Zendesk, HubSpot, …) feed one
importer. *Rejected:* streaming source records straight into tables (couples
every connector to the loader; loses the resumable, inspectable staging
artifact); keeping the connector in a sandbox plugin (D1).

**D12 — Single-org deployment in v1; retain an explicit multi-org seam.**
Every engine and app row still carries `org_id`, and GraphJin policies still
filter/preset it from the JWT. That is defense in depth and keeps a future
migration possible; it is **not** a claim that v1 safely multiplexes tenants in
one `records-db`. Physical table names (`<app>__<object>`) and `Text @id`
primary keys are deployment-global, so two orgs installing the same app—or
importing the same source id—would collide. v1 therefore supports exactly one
organization per OpenNeko deployment. A future multi-org mode must first encode
tenant identity into physical table families and record keys (or isolate each
tenant in its own database), then add adversarial cross-tenant tests. *Rejected:*
calling an `org_id` column alone multi-tenant isolation.

**D13 — Packaging: engine ships in core.**
With no plugin in the picture the earlier OSS-core vs paid-module question
collapses to feature packaging inside the product (edition gating at most).
Nothing below depends on the answer.

**D14 — CSV import is a baseline capability of every app.**
An app built in conversation starts empty; the data it needs almost always
exists as a spreadsheet. So every app accepts CSVs from day one, in two forms,
both through the C8 machinery: **(a) into an existing object** — the agent
proposes a column→field mapping (suggesting new fields via `app_field_add`
where headers don't match), the approval card shows the mapping, row count,
and sample rows before anything loads; **(b) as new objects or a new app** —
headers + typed sampling infer a schema that becomes an ordinary
`app_create` / `app_object_create` proposal. v1 loads are insert-only with a
duplicate-detection report; upsert-by-chosen-key is a follow-on option. The
full artifact-directory contract (describe metadata, manifests, watermarks)
remains the connector-grade path; plain CSV is the floor beneath it.
*Rejected:* routing bulk rows through `record_create` one at a time (the
action stack carries intent, not 50k rows — one approval covers the load, the
import report is its audit); treating import as a Salesforce-only feature.

**D15 — User apps have pages; OpenNeko platform screens stay native.**
The generated UI is not only CRUD. An app can declare **pages** —
compositions of query-driven blocks (metric card, list, feed/timeline) stored
as app-scoped registry content (`engine.app_page`; definition = blocks of
`{label, query, renderer, span}`) and rendered by one generic page renderer,
every block's query running under the viewer's JWT like any read (D5). That
makes "why hardcode screens?" the right question: a CRM overview with
pipeline metric cards is registry data the agent can create and evolve, not
code. The boundary is intentionally simple: **all OpenNeko platform screens
stay hardcoded native UI** — Home/dashboard, Briefing, Work/chat, Workflows,
Approvals, setup, settings, health, and the navigation shell. Registry-defined
pages exist only inside user-created apps and must be visually incapable of
imitating native approval/settings controls. *Rejected:* built-in apps for
OpenNeko screens; a widget/plugin SDK for pages (blocks are a fixed renderer
set the app engine grows deliberately).

**D16 — Screen taxonomy: native OpenNeko or user-created app.**

| Tier | Surfaces | Rationale |
|---|---|---|
| **Native OpenNeko** | Home/dashboard; Briefing; Work/chat; Workflows; Approvals; Setup; Settings (users, secrets, sources, plugins, health); navigation shell | Platform, control-plane, and trust surfaces stay hardcoded. They are never registry content and are not part of the app-builder roadmap. |
| **User-created apps** | CRM, support desk, inventory, and anything the user + agent decide to build (D2a–d) | Business domains: agent-proposed registry + GraphJin data layer + generated records/pages UI + CSV import. |

**Shipping user-app blueprints on demand:** because an app is data, a
vendor-shipped starting point is a **versioned app definition** — blueprint JSON + optional connector reference
+ skill pack. v1 ships definitions in-repo (`packages/records/blueprints/`);
follow-on adds a remotely-updatable catalog ("OpenNeko ships a field-service
app this quarter" without a platform release). Installing or upgrading a
shipped app applies the definition (or its version diff) through the same
approval-gated C3 executor as every schema change — the vendor proposes,
the operator approves, and an upgrade can never silently reshape data (D7
rules apply: additive, archive-not-drop).

---

## 3. Components

| # | Component | Location | Phase |
|---|-----------|----------|-------|
| C1 | `records-db` + `records-graphjin` services & provisioning | `compose.yml`, packaged compose, `db/records/` | 0 |
| C2 | Engine metadata registry | `db/records/migrations/`, `packages/records/` | 0–1 |
| C3 | App builder — durable schema saga + DDL executor | `apps/worker/src/records/schema/`, `packages/records/` | 0–1 |
| C4 | Record write path (`record_*` adapters) | `apps/worker/src/records/` | 0–1 |
| C5 | Dedicated GraphJin integration (config, roles, tokens, watches) | `packages/records/src/graphjin/`, `packages/records/src/policy/` | 0–1 |
| C6 | Auto-generated web UI (`/a/[app]`) | `apps/web/src/app/a/` | 1 (read/minimal forms) / 3 (full ergonomics) |
| C7 | RBAC policy module (shared read/write source of truth) | `packages/records/src/policy/` | 0–1 |
| C8 | Importer — baseline CSV import (every app) + staged-artifact import | `packages/records/src/import/`, worker job | 1 (CSV) / 2 (artifacts) |
| C9 | First-party connector framework + Salesforce connector (mirror/cutover sync) | `packages/records/src/connect/` | 2 |
| C10 | Identity mapping (source users ↔ `app_user`) | `packages/records/src/identity/` | 2 |
| C11 | Agent skills & blueprints (app-builder, records, domain packs) | `packages/llm/assets/builtin-skills/` | 1–2 |
| C12 | Watcher/briefing integration (`gj_watch`) | worker + seeds + docs | 3 |
| C13 | Backup, disk & ops resilience (see §6) | compose sidecar, worker jobs, CLI | 0 (backup/restore) / 2 (watchers) |

Dependency spine:
C1 → C2 → C3 → {C4, C5} → C6(read) → C6(forms);
C8 depends on C3 (imports *are* app creation) and feeds C10; C9 feeds C8's
contract; C11 rides C3/C4; C12 rides C5. C13 depends only on C1 and lands with
it — business-critical data is never live without a backup path.

### 3.1 Implementation preconditions

The vision is approved, but broad implementation does not start until the
following invariants are proven by the Phase 0 spike (§5):

1. **One records data plane, with its own GraphJin process.** Records uses a
   dedicated `records-graphjin` service and file generator. It does not reuse
   the customer-source `sources:` persistence helper because explicit
   `roles[].tables` cannot coexist with `sources:` in one GraphJin config.
2. **Single-org v1 is explicit.** `org_id` remains on rows and in policies, but
   a deployment hosts one org until physical names and keys are tenant-safe
   (D12).
3. **Schema apply is a saga, not a distributed transaction.** GraphJin DDL,
   the records registry, and the metadata-DB mirror cannot commit atomically.
   A durable desired revision, phase journal, idempotent retry, and boot-time
   reconciler make partial progress observable and recoverable.
4. **Approval binds exact bytes.** Execution re-diffs the live catalog and
   requires the resulting DDL/SQL hash and catalog revision to match the
   approved preview. Drift invalidates the approval and produces a new card.
5. **Authorization fails closed.** Human GraphJin roles are read-only; only the
   worker service role mutates. Policies cover every live table—including
   archived, orphaned, engine, and just-created tables—with no exposure window.
6. **Command idempotency is separate from row history.** One action can change
   many rows. A command receipt is unique by action request; the change log is
   one-to-many and never used as the command claim.
7. **Imports checkpoint beside their writes.** Target-side run/batch receipts
   are authoritative; metadata `app_state` is an orchestration mirror only.
8. **Operational recovery is part of the first slice.** An encrypted,
   coherent, verified backup plus restore reconciliation exists before real
   business data is accepted.
9. **The mockup tests mechanisms, not CRM exceptions.** M1 proves generated
   content and a second adversarial domain fixture; M2 proves the complete
   Ask/approval/pending scenario. No parity fix may add app-specific code.

---

## 4. Component implementation plans

### C1 — `records-db` + `records-graphjin` services & provisioning

**What:** a dedicated Postgres container for business data, a dedicated
GraphJin process for its data plane, and their lifecycle plumbing.

- `compose.yml` **and** `apps/openneko/assets/compose/core.yml`: add
  `records-db` (postgres:16, own named volume, healthcheck, password
  provisioned like `neko-db`'s and rotated via `/setup`) and
  `records-graphjin` (pinned GraphJin image/binary, own config volume,
  healthcheck, private network exposure only). The development and packaged
  compose definitions, Dockerfile targets, CLI service lists, setup/upgrade
  code, and embedded migrations are one release checklist and must stay in
  lockstep. They may be provisioned on first user-app creation so deployments
  that never use the app engine keep the current platform stack unchanged.
- `packages/records/src/graphjin/config.ts`: owns the complete records config
  (`database`/`databases`, auth, `roles`, `roles_query`, table aliases,
  query budgets, DDL directory). It writes under a records-specific lock,
  validates with the pinned binary, atomically replaces the config, and
  reloads only `records-graphjin`. The customer-source
  `persistGraphjinSourceConfigUpdate` path is deliberately not reused.
- `db/records/migrations/`: engine-schema migrations, numbered from `0001`,
  **separate stream** from `db/migrations/` (different database, different
  lifecycle). Applied by the worker on first app creation and on boot when any
  app exists (same runner pattern as the metadata migrations; add
  `packages/db/src/records-migrate.ts`).
- Metadata-DB migration `0051_app_state.sql` (next free number after `0050`):

  ```sql
  CREATE TABLE app_state (
    org_id     text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    app_id     text NOT NULL,               -- 'crm', 'support'
    status     text NOT NULL DEFAULT 'draft',
      -- draft | provisioning | importing | active | degraded | archived
    created_by text,                        -- app_user id of the approver
    created_at timestamptz NOT NULL DEFAULT now(),
    config     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- import provenance, connector state
    PRIMARY KEY (org_id, app_id)
  );
  ```

  (Mirror of the registry's `record_app` status, held in the metadata DB so
  nav gating, job orchestration, and doctor checks don't depend on
  `records-db` being reachable.)
- `openneko` CLI: `openneko records status` (connectivity, migration level,
  app states) folded into `openneko doctor`.

**Testing:** migration integration test in the existing style
(`packages/db/test/integration/migrations.test.ts`); compose smoke via
`pnpm dev:setup`.

### C2 — Engine metadata registry

**What:** the tables that make everything else generated, in `records-db`
schema `engine`, plus a typed accessor package. Unlike the earlier draft, the
registry is **writable at runtime** — by exactly one writer, the C3 schema
executor.

Registry DDL (abridged; top-level tables carry `org_id`, child receipt rows are
scoped through a parent foreign key):

```sql
CREATE TABLE engine.record_app (
  app_id text NOT NULL, org_id text NOT NULL,
  label text NOT NULL, purpose text,        -- the sentence the app was created from
  status text NOT NULL DEFAULT 'draft',
  nav_order int NOT NULL DEFAULT 0,
  registry_revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, app_id)
);

CREATE TABLE engine.record_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL, app_id text NOT NULL,
  api_name text NOT NULL,          -- 'account', 'my_object__c' (sanitized, immutable)
  source_api_name text,            -- 'Account', 'My_Object__c' (verbatim, when imported)
  label text NOT NULL, plural_label text NOT NULL,
  table_schema text NOT NULL,      -- records source default schema (D4)
  table_name text NOT NULL,        -- '<app>__<object>' prefix convention (D4)
  name_field text NOT NULL DEFAULT 'name',
  visibility text NOT NULL DEFAULT 'org',   -- 'org' | 'owner'  (D8)
  is_custom boolean NOT NULL DEFAULT false,
  archived_at timestamptz,                  -- D7 archive, never drop
  record_count bigint,             -- refreshed post-import / periodically, for nav
  UNIQUE (org_id, app_id, api_name)
);

CREATE TABLE engine.record_field (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  object_id uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  api_name text NOT NULL, source_api_name text,
  label text NOT NULL,
  kind text NOT NULL,
    -- id|text|textarea|boolean|integer|decimal|currency|percent|date|datetime|
    -- email|phone|url|picklist|multipicklist|reference|readonly_formula
  column_name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  read_only boolean NOT NULL DEFAULT false,   -- formulas, legacy audit (D9)
  archived_at timestamptz,                    -- D7
  picklist_values jsonb,                       -- [{value,label,active,color?,emphasis?,semantic?}]
  reference_targets jsonb,                     -- [target api_name]; >1 supports polymorphic ids
  length int, scale int,
  UNIQUE (object_id, api_name)
);

CREATE TABLE engine.record_relationship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  from_object uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  from_field uuid NOT NULL REFERENCES engine.record_field(id) ON DELETE CASCADE,
  to_object uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  relationship_label text                      -- related-list heading
);

CREATE TABLE engine.record_layout (        -- generated defaults; editable via actions
  object_id uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  kind text NOT NULL DEFAULT 'detail',     -- 'detail' | 'list'
  definition jsonb NOT NULL,               -- sections/columns of field api_names
  PRIMARY KEY (object_id, kind)
);

CREATE TABLE engine.app_page (             -- app-scoped overview/custom pages (D15)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL, app_id text NOT NULL,
  api_name text NOT NULL, label text NOT NULL,
  definition jsonb NOT NULL,               -- closed-set block definitions
  nav_order int NOT NULL DEFAULT 0,
  UNIQUE (org_id, app_id, api_name)
);

CREATE TABLE engine.saved_view (           -- distinct from the default list layout
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  object_id uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  owner_user_id text,                      -- null = org-owned/shared
  label text NOT NULL,
  definition jsonb NOT NULL,               -- semantic filter AST, sort, columns
  shared boolean NOT NULL DEFAULT false,
  UNIQUE NULLS NOT DISTINCT (org_id, object_id, owner_user_id, label)
);

CREATE TABLE engine.record_permission (    -- D8
  org_id text NOT NULL, app_id text NOT NULL,
  role text NOT NULL,                      -- 'admin' | 'member' (extensible)
  object_api_name text NOT NULL,
  can_read boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  can_update boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, app_id, role, object_api_name)
);

CREATE TABLE engine.record_change_log (    -- D6; the data audit trail
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL, app_id text NOT NULL,
  object_api_name text NOT NULL, record_id text NOT NULL,
  action text NOT NULL,                    -- create|update|delete|import|sync
  actor_user_id text,                      -- null = service/import
  action_request_id text,                  -- FK-by-value into metadata DB
  mutation_id text NOT NULL,               -- unique per changed row
  operation_seq int NOT NULL DEFAULT 0,
  changes jsonb NOT NULL,                  -- {field: {from, to}}
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON engine.record_change_log (org_id, object_api_name, record_id, at DESC);
CREATE UNIQUE INDEX ON engine.record_change_log (mutation_id);

CREATE TABLE engine.action_execution (    -- command-level idempotency/lease
  action_request_id text PRIMARY KEY,      -- FK-by-value into metadata DB
  org_id text NOT NULL, app_id text,
  action_kind text NOT NULL,
  status text NOT NULL,                    -- claimed|running|succeeded|failed
  lease_owner text, lease_expires_at timestamptz,
  result jsonb, error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);

CREATE TABLE engine.app_schema_change (   -- mutable saga state; log below is append-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL, app_id text NOT NULL,
  action_request_id text NOT NULL UNIQUE,
  desired_revision bigint NOT NULL,
  catalog_revision text NOT NULL,
  graphjin_ddl jsonb NOT NULL,
  preview_sql text NOT NULL,
  preview_hash text NOT NULL,
  phase text NOT NULL,                     -- planned|approved|applying|applied|projected|failed
  attempts int NOT NULL DEFAULT 0,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine.app_schema_log (       -- D6/D7; the schema audit trail
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL, app_id text NOT NULL,
  action text NOT NULL,        -- app_create|object_create|field_add|field_modify|
                               -- object_archive|permission_set|layout_update|hard_drop
  detail jsonb NOT NULL,       -- proposed change, resolved names
  ddl jsonb,                   -- {graphjin_ddl, preview} as submitted/returned
                               -- (null for registry-only changes)
  actor_user_id text,
  action_request_id text,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine.identity_map (         -- C10
  org_id text NOT NULL,
  source_instance_id text NOT NULL,        -- connector/source configuration identity
  app_id text NOT NULL,
  source_user_id text NOT NULL,            -- e.g. 18-char SF user id
  source_email text NOT NULL, source_name text, source_is_active boolean,
  app_user_id text,                        -- null until linked
  status text NOT NULL DEFAULT 'unlinked', -- linked|unlinked|conflict|ignored
  linked_at timestamptz,
  PRIMARY KEY (org_id, source_instance_id, app_id, source_user_id)
);

CREATE TABLE engine.import_run (           -- authoritative target-side progress
  id uuid PRIMARY KEY,
  org_id text NOT NULL, app_id text NOT NULL,
  action_request_id text NOT NULL UNIQUE,
  source_instance_id text,
  status text NOT NULL, plan_hash text NOT NULL,
  current_stage text, result jsonb, error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engine.import_batch_receipt (
  import_run_id uuid NOT NULL REFERENCES engine.import_run(id),
  object_api_name text NOT NULL,
  batch_no int NOT NULL,
  batch_hash text NOT NULL,
  row_count int NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (import_run_id, object_api_name, batch_no),
  UNIQUE (import_run_id, batch_hash)
);

CREATE TABLE engine.sync_cursor (          -- target-side delta watermark
  org_id text NOT NULL, app_id text NOT NULL, source_instance_id text NOT NULL,
  object_api_name text NOT NULL,
  watermark jsonb NOT NULL,
  last_batch_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app_id, source_instance_id, object_api_name)
);
```

**Accessor package:** new `packages/records/` workspace package —
`registry.ts` (typed loads + an in-process cache invalidated on a registry
version row the C3 executor bumps), `naming.ts` (source-name → sanitized
identifier rules: lowercase, `__c` preserved, reserved words suffixed, 63-byte
truncation with hash disambiguation — **the only path to an identifier**,
security-sensitive), `types.ts`. Web, worker, importer, and executor all
consume this package; nobody re-implements registry access.

**Testing:** exhaustive unit tests for naming edge cases (permanent API
surface); registry round-trip integration test against a disposable Postgres;
cache-invalidation test across two connections.

### C3 — App builder: schema action adapters + DDL executor

**What:** the component the rethink adds — the machinery that turns "create an
app to replace Zendesk" into a schema. Action kinds (D6), all registered via
`registerActionAdapter`:

| Kind | Default mode | Effect |
|---|---|---|
| `app_create` | `ask` | registry app row + prefixed app tables + `app_state` row; body carries the full initial object/field set so **one approval card shows the whole proposed app** |
| `app_object_create` | `ask` | registry rows + `CREATE TABLE` (+ indexes, `nk_*` audit columns, `owner_user_id` when owned) |
| `app_field_add` | `ask` | registry row + `ALTER TABLE ... ADD COLUMN` |
| `app_field_modify` | `ask` | label/picklist/required/layout tweaks (registry-only); a type change is never in-place — the adapter returns the add-new-field + backfill + archive-old counter-proposal (D7) for the agent to propose |
| `app_object_archive` / field archive | `ask` | sets `archived_at`; hides from UI/agent/GraphJin projection; **no DDL, no data loss** |
| `app_permission_set` | `ask` | updates `record_permission`; triggers C5 role regeneration |
| `app_layout_update` | `ask` | layout/page JSON only — no schema or policy effect, but still an operator-visible change to the app |

Executor rules: GraphJin's individual DDL apply is transactional, but the
records registry, the GraphJin subprocess, config projection, and metadata-DB
mirror are not one transaction. C3 therefore executes a **durable saga** from
`engine.app_schema_change`; no prose or code may describe the whole operation
as atomic.

1. Everything named passes through `naming.ts`; identifiers are always quoted.
2. The executor projects the registry delta into a **GraphJin DDL document**
   (desired-state `type` definitions — no SQL authored anywhere in OpenNeko)
   and drives the shipped binary: `graphjin db diff` renders the technical SQL
   delta stored with the proposal, and `graphjin db sync --yes` applies it in one
   transaction with rollback-on-error, and the schema reloads so new tables
   are queryable (role/permission projection still regenerates under
   the records-specific config lock). Destructive mode is **never enabled** —
   archive semantics (D7) mean the engine never asks GraphJin to drop
   anything, and the diff engine is additive-only regardless
   ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1). Schema conventions in
   the DDL doc: PK `id: Text! @id` (imported apps keep source IDs,
   from-scratch apps default to UUID-as-text), `@index` on reference columns
   and the name field, `multipicklist → Jsonb` (Postgres arrays are
   inexpressible in GraphJin DDL), **no `@default`** (unsanitized
   passthrough — defaults are write-path behavior), **no FK constraints**
   (integrity reported, not enforced — legacy data has dangles). The
   additive-only diff is embraced as the mechanical enforcement of D7:
   type changes are add-new-field + backfill (batched GraphJin updates) +
   archive-old — every step additive, every step through GraphJin.
   Index-on-existing-column is a documented limitation (indexes are chosen
   at field creation; adding later is an upstream contribution candidate).
   Alongside the tables, provisioning installs the **audit trigger** that
   powers C4's change-log capture. This is an explicitly bounded substrate
   DDL path, not an app-data write path: the trigger function is versioned in
   `db/records/migrations/`, attachment is idempotent and executor-owned, and
   boot reconciliation verifies every live app table has the current trigger.
3. Proposal persists the desired registry revision, live-catalog revision,
   GraphJin DDL, preview SQL, and a hash over all four. The approval card shows
   only the high-level object/field/relationship plan, warnings, and expected
   effects—never raw SQL. The technical artifact remains in the schema log for
   audit/debug and is bound to the card by its hash. Immediately before apply,
   the executor re-reads
   the live catalog and re-runs `db diff`; any revision or hash mismatch marks
   the proposal stale and requires a fresh approval. Only C3 possesses DDL
   credentials; a records-schema lease serializes every engine DDL operation
   across the final diff, `db sync`, and post-apply catalog verification.
   `db sync` may execute only while the final diff matches the approved hash.
4. The saga advances idempotently through `planned → approved → applying →
   applied → projected`. `applied` means the physical DDL and trigger exist;
   `projected` means registry rows, exhaustive GraphJin policy/config, and the
   metadata `app_state` mirror all reflect the desired revision. Every phase
   appends an `app_schema_log` event. On boot, and after any failure, a
   reconciler compares desired registry state, live catalog, config revision,
   and metadata mirror and resumes from the last proven phase.
5. New-table rollout is fail closed. While a table is created and its trigger
   and policies are projected, `records-graphjin` is removed from readiness
   and accepts no requests. C5 introspects the resulting live catalog, emits
   explicit rules for every table, validates the full config, atomically
   reloads it, and only then restores readiness. A failed projection leaves
   the data plane degraded, never permissive.
6. Successful `app_create` projection marks both registry and metadata mirror
   `active`. Navigation and `/a/[app]` discover the app from those rows, so the
   generated UI and CSV-import affordance appear immediately without a deploy,
   generated source file, or plugin install.
7. `hard_drop` is **not an action kind**. It exists only as
   `openneko records drop --app X --object Y` with typed confirmation and a
   fresh-verified-backup check (D7).
8. Gating: the records configuration runs `analytics_mode: true` +
   `read_only: false` (see D5) — DDL applies only through the worker's C3
   wrapper (which holds the binary + connection), and mutations only under
   worker-held `service` credentials via the generated role config.
   Customer data sources keep their source-mode `read_only: true` config,
   which blocks all mutations and DDL — unchanged from today.

**Blueprints:** `packages/records/blueprints/*.json` — starter app definitions
(CRM: account/contact/opportunity/activity; support: ticket/requester/queue
with status/priority picklists). A blueprint is input the agent adapts and
proposes through `app_create`; it is never auto-applied.

**Testing:** adapter integration tests in the `action-flow` style
(`packages/llm/test/integration/action-flow.test.ts`): full app create from a
blueprint fixture; lossless vs lossy type-change paths; archive hides but
retains; identifier-injection attempts (hostile labels) rejected by
`naming.ts`; schema-log/DDL correspondence; preview/apply catalog drift forces
re-approval; a kill at every saga phase reconciles on restart; a just-created
table is never queryable before its exhaustive deny/grant projection; concurrent
app-create races (second one fails cleanly on the registry unique).

### C4 — Record write path

**What:** the data-side adapters — `record_create` / `record_update` /
`record_delete` / `record_restore` in `apps/worker/src/records/adapters.ts`, registered alongside
the manage-adapters at worker boot.

Payload shapes (declared with `example` payloads so the agent emits them
correctly on the first try):

```jsonc
// record_create                          // record_update
{ "app": "crm",                           { "app": "crm",
  "object": "contact",                      "object": "opportunity",
  "fields": {                               "id": "0065g00000ABCDEAA4",
    "lastname": "Rivera",                   "fields": { "stagename": "Negotiation",
    "accountid": "0015g00000XYZ" } }          "closedate": "2026-08-15" },
                                            "expected": { "stagename": "Proposal" } }
// record_delete
{ "app": "crm", "object": "contact", "id": "0035g00000QRSTU" }
```

Executor steps, in order — every write is a GraphJin mutation as `service`
(D6), one atomic statement plus its audit trigger:

1. Resolve registry entry (object + fields, non-archived); unknown → typed
   error.
2. **Validate** from `record_field`: kinds, required (create only), picklist
   membership, length/scale, `read_only` rejection, reference-target existence
   (warn-not-block for legacy dangles, block for new dangles).
3. **RBAC** (C7): acting user's role + `record_permission` CRUD grant +
   ownership rule for `visibility='owner'` objects. Actor comes from the
   action request's actor snapshot.
4. **Atomic execution claim:** insert or lease
   `engine.action_execution(action_request_id)` before calling GraphJin. A
   succeeded receipt returns the stored result; a live lease prevents a second
   executor; an expired lease may be reclaimed. The row history is never used
   as a command lock because one action may legitimately change many rows.
5. Execute the mutation: `insert` for create; `update` for update **and**
   soft delete (`nk_deleted_at` — recycle-bin semantics; `delete` mutations
   are blocked for every role). Stamp `nk_updated_by/at` +
   `nk_action_request_id` and a deterministic per-row `nk_mutation_id` in the
   same mutation (`nk_created_*` on create).
   **Optimistic concurrency in the `where`:** `record_update.expected`
   values fold into the update filter — an empty result array means the
   expectation failed, a typed error the agent can re-plan on. Race-free,
   enforced in-engine.
6. The provisioning-installed audit trigger writes
   `engine.record_change_log` (field-level OLD/NEW diff, actor,
   `action_request_id` and `mutation_id` from the row) in the same transaction.
   Multiple rows may share one action request; only `mutation_id` is unique.
7. Mark the execution receipt succeeded with the serializable outcome; the
   workflow layer records `(table, pk)` into
   `workflow_run.source_writes` for the subscription cycle-check.

**Soft-delete contract:** every generated human/service read, aggregate,
relationship lookup, reference typeahead, watcher, and count adds
`nk_deleted_at IS NULL` unless it explicitly targets the recycle bin. Restore
is a typed `record_restore` update through this same executor. The service role
does not silently bypass deletion or org filters; maintenance operations opt
into those scopes explicitly.

Default `action_policy` seeding on app creation: create/update/delete → `ask`
(operators can rule-in `auto` for safe classes, e.g. activity logging).

**UI form path:** `/a/*` form submits POST to a records API route that creates
the action request pre-approved (actor = session user, noted "form submit")
and awaits execution — one executor, one log; a `deny` policy blocks forms
too, which is correct.

**Testing:** extend the `action-flow` pattern for the three kinds: validation
failures, RBAC denials, concurrency conflict, change-log diff correctness,
`source_writes` recording, soft delete hidden across lists/counts/relationships/
watches, restore, multi-row actions sharing one request id, lease recovery, and
replay idempotency.

### C5 — GraphJin integration

**What:** stand up the records GraphJin configuration (jwt auth, generated
roles); project policy into role config; serve reads, mutations for the
executors, and `gj_watch` standing watches.

- **Dedicated instance/config:** on first app creation, C1 provisions the
  private `records-graphjin` service and C5 writes its complete standalone
  file config via `packages/records/src/graphjin/config.ts`. Connection and
  signing secrets still use the normal secret/key derivation mechanisms, and
  a metadata `data_source` row may point at the endpoint for catalog discovery,
  but `register_source` and `persistGraphjinSourceConfigUpdate` never author
  this config. The records config owns no `sources:` block.
- **Role generation (C7 output):** `packages/records/src/policy/graphjin.ts`
  projects `record_permission` + `record_object.visibility` into GraphJin's
  **Table-permissions `roles:` config** (D5,
  [RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §2): per role × per table, all
  five operations explicit — `admin`/`member` get query grants with column
  lists and `block: true` on every mutation (the D6 write path is
  role-enforced); row filter `"{ owner_user_id: { eq: $user_id } }"` on
  `visibility='owner'` tables for `member` ($user_id resolves from the JWT
  `sub`); `service` is the one mutation-capable role, with org presets/filters
  and deleted-row defaults retained as defense in depth; its credentials are
  held only by the worker. Role resolution uses `roles_query` against
  `engine.actor` (user → role, worker-synced from `app_user`); missing or stale
  actor rows resolve to no privileged role. **The projection is exhaustive by
  construction and live-catalog driven** — with explicit role tables an
  omitted table grants access, so generation introspects every physical table
  and emits every role × operation, including explicit blocks for archived or
  orphaned app tables and every `engine.*` table not intentionally exposed.
  Registry grants may narrow that catalog; they may never define its complete
  universe. Regenerated on every C3 schema action and every permission change,
  with a drift audit on boot.
- **Query/resource budgets:** disabling the allow-list does not mean unlimited
  work. The data-plane boundary uses native GraphJin/Postgres controls where
  available and the OpenNeko query builder/reverse proxy where they are not to
  enforce statement timeouts, maximum query depth/complexity, row and
  aggregate/card limits, bounded regex/`in` inputs, and per-actor rate limits.
  Generated analytics queries are explicit exceptions with their own higher
  ceilings. Budget rejection is typed and visible in the UI/agent.
- **Watching (the "watch" in the rethink):** two GraphJin layers, used for
  what each is good at ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §3).
  **`gj_watch` is the primary records watch mechanism**: durable
  cursor-backed standing subscriptions with persisted checkpoints
  (restart/failover-safe — nothing missed), evaluated under the owner's
  stored identity and role (never elevates access), deterministic event
  IDs, a durable event inbox, absence watches ("no shipment scan for four
  hours" as a first-class event), digest coalescing, rollups, and
  webhook/workflow delivery gated by exact-hash approval — the same
  propose/approve philosophy as our action stack. OpenNeko's watcher
  machinery consumes `gj_watch_event` (webhook into the worker,
  allowlisted). Raw live-query subscriptions (at-most-once, poll-based;
  `subs_poll_duration` set explicitly) serve **UI freshness only**.
  `workflow_run.source_writes` keeps self-triggering loops broken in every
  mode.
- **Web tokens:** helper for `/a/*` API routes minting
  `mintGraphjinToken({orgId, userId, role})` from the session — same claims
  shape the agent path uses.

**Testing:** config-generation snapshot tests (permission fixtures → YAML)
incl. the exhaustiveness assertion against the live catalog (every table ×
role × operation, including orphaned/archived/engine tables); stale/missing
actor rows fail closed; service mutations cannot cross org scope;
live-GraphJin integration test asserting member-vs-admin row visibility on an
`owner`-visibility table; watch smoke (insert via executor → `gj_watch`
event fires and survives a runner restart via its stored cursor; write from
the same run → cycle-check suppresses); negative load tests reject deep joins,
unbounded aggregates, expensive regexes, and oversized literal lists within
the configured budgets.

### C6 — Auto-generated web UI (`/a/[app]`)

**What:** `apps/web/src/app/a/[app]/` — a fully metadata-driven section. Every
app gets it with zero app-specific code; it appears in nav the moment
`app_state.status = 'active'`.

> **Mockup & detailed UI plan:** [`mockups/crm-main-screen.html`](mockups/crm-main-screen.html)
> shows the list view (for the CRM app) built from the app's design tokens;
> [`mockups/README.md`](mockups/README.md) maps every mockup region to
> components, routes, data sources, and milestones.

Routes:

```
/a/[app]                       → app home: generated overview page (D15 blocks)
                                 when defined; else object nav + pinned views
/a/[app]/[object]              → list view: server-driven table; filter/sort/
                                 search on registry fields; saved views (later)
/a/[app]/[object]/[id]         → record detail: layout sections; related lists
                                 from record_relationship; change-log timeline;
                                 inline ask-box
/a/[app]/[object]/new          → generated create drawer/page (minimal Phase 1)
/a/[app]/[object]/[id]/edit    → generated edit drawer/page (minimal Phase 1)
/a/[app]/admin                 → import report, identity mapping, permissions,
                                 schema history (app_schema_log)
```

- **Reads:** API routes under `/api/a/...` mint the user's GraphJin token (C5)
  and query GraphJin — generated GraphQL documents (columns, filter args,
  cursor pagination); no direct SQL (D5). Generated queries always carry
  explicit limits: the records source runs `analytics_mode`, so nothing is
  implicitly capped — right for aggregates, and list queries must therefore
  paginate deliberately.
- **Field rendering/edit widgets** keyed on `record_field.kind` — one
  component per kind. Reference lookups search the target object's
  `name_field` via the same read path.
- **Filter model:** list layouts and saved views store a typed semantic AST,
  not GraphQL fragments: field/operator/value leaves plus relative-date macros
  (`this_quarter`, `last_n_days`) and picklist semantics such as open/closed.
  The query generator validates the AST against registry fields and emits
  GraphJin shapes with leaf variables only.
- **Page renderer (D15, Phase 3):** one generic component walking an
  `app_page.definition` — block renderers for metric card,
  list, and feed/timeline to start; each block's query is registry-generated
  and runs under the viewer's JWT. Layout edits arrive via the
  `app_layout_update` action ("add a card for open deals to this app's
  overview").
- **The ask-box** (the differentiator): every list and record view embeds a
  chat entry pre-scoped with app/object/record context (routes into the
  existing work-thread machinery with a context preamble). "Log yesterday's
  call, push close date two weeks" → agent proposes `record_update` → the
  approval card renders inline in the thread, consistent with `/work`.
  Schema-change proposals render the same way — "add a T-shirt-size field to
  deals" is an approval card in the same thread.
- **Nav integration:** app sections injected into the app shell nav from
  `record_app` + `app_state`, after Briefing/Work. Large imported apps use an
  app switcher plus favorite/recent objects, object search, and collapsed
  groups; hundreds of Salesforce objects are never rendered as one permanently
  expanded rail.
- **Honest degradation:** when `records-db` or `records-graphjin` is
  unavailable, app routes show a prominent degraded banner with health/status
  details. The quiet substrate strip is for healthy/background status, not an
  outage indicator.
- **Change-log timeline** on record detail reads `engine.record_change_log`;
  the admin schema-history page reads `engine.app_schema_log`.

**Testing:** component tests for the field-widget matrix; e2e against a seeded
mini-registry: nav gating, list filtering, detail related-lists, form
round-trip through the action path, member-vs-admin visibility. Plus the
**mockup-parity tests** ([mockups/README.md](mockups/README.md) §7–8): M1
matches the generated-content region and proves a second non-CRM fixture; M2
matches the complete Ask/approval/pending scenario. Both render through the
real generated pipeline — the mockup is the acceptance criterion, and any
parity failure is a registry/renderer gap, never grounds for a special case.

### C7 — RBAC policy module

**What:** the single source of truth both surfaces consume —
`packages/records/src/policy/`:

- `evaluate.ts`: `canRead/canCreate/canUpdate/canDelete(actor, object,
  record?)` from `record_permission` + `visibility` + ownership — used by C4
  (writes), C3 (schema actions are admin-only), and C6's route guards
  (defense in depth over GraphJin's read enforcement).
- `graphjin.ts`: the C5 role/filter projection. Same inputs, mechanical
  output.
- Permissions admin UI (C6 `/admin`) edits via `app_permission_set` actions;
  approval triggers the config regeneration.

Rule: no other module may read `record_permission` directly.

**Testing:** table-driven unit tests over the permission matrix; a drift test
asserting `evaluate.ts` and the generated GraphJin filters agree on a fixture
set.

### C8 — Importer

**What:** one import machinery, two granularities. Runs as a worker pg-boss
job (new `QUEUE.RECORDS_IMPORT` in `packages/db/src/jobs.ts`), triggered by an
action adapter (`records_import_start`, with `_status` / `_cancel`) so chat
drives it with an approval card, and by CLI
(`openneko records import --app crm --dir ./sf-export` /
`--object equipment --file loans.csv`).

**Baseline CSV import — every app, Phase 1 (D14):** one or more plain CSVs
into an existing object, or as new objects/apps. The flow is the D14 mapping
card: agent proposes column→field mapping (with `app_field_add` suggestions
for unmatched headers, chained as one approval), card shows mapping + row
count + sample rows, then the load runs stages 1→3→6 below (schema stage only
when fields/objects are being created). CSVs arrive by web upload on the
`/a/[app]/admin` import surface (staged to a worker-owned directory), by host
path via CLI, or from an already-registered `file` data source (local|s3|gcs).
Insert-only in v1 with a duplicate report; upsert-by-key later.

**Artifact-directory import — connector-grade, Phase 2 (one contract, any
feeder — D11):** a directory containing `data/<object>.csv`, optionally
`describe/*.json` (source metadata) and `export-manifest.json` (per-object
expected row counts + export watermarks). The connector framework (C9)
produces all three; a client-supplied CSV dump of a whole system is the manual
feeder, with type inference filling in for missing describes. Import *is* app
creation: the schema stage runs through the C3 executor, so an imported app
and a conversation-built app are the same kind of thing.

**Change-log policy for bulk loads:** loads below a row threshold write
per-record `import` entries to `engine.record_change_log`; above it, one
aggregate import event per object (file hash, row counts, reject counts,
provenance in `engine.import_run.result`) with the import report as the audit — the
change log stays useful instead of drowning.

Pipeline stages are checkpointed in target-side `engine.import_run` and
`engine.import_batch_receipt`, in the same database as the inserted records.
Each batch has a deterministic hash and its receipt commits with that batch's
mutation; a crash cannot commit rows without authoritative progress. The
metadata `app_state.config.import` value is a best-effort orchestration/status
mirror, never the resume authority. Progress remains visible via
`records_import_status` and a briefing card.

1. **Manifest.** Read `describe/*.json` when present (exact types, picklists,
   relationships, profiles); else infer per CSV: header names + typed sampling
   (10k rows) with the type-mapping table below. Emit an **import plan** — a
   proposed `app_create` payload — that the approval card shows *before*
   anything is written.
2. **Schema.** Apply the plan through the C3 executor (one logged
   `app_create`). Source → PG mapping (Salesforce flavor):
   `id/reference → char(18)`, `string/textarea/email/phone/url/picklist → text`,
   `multipicklist → jsonb` (Postgres arrays are inexpressible in GraphJin
   DDL), `boolean → boolean`, `int → integer`,
   `double/currency/percent → numeric`, `date → date`, `datetime → timestamptz`,
   `address/location → flattened columns`, `base64 → skipped (D9)`.
   Formula/rollup → materialized column of result type, `read_only`.
   `owner_user_id text` beside the source owner column where owned.
3. **Load.** Parse each CSV (RFC-4180 with embedded newlines; empty-string
   → NULL except genuinely empty text; source datetime/boolean literal
   handling) and load through **batched GraphJin array-insert mutations**
   as `service` (D6 — one atomic statement per batch; no `COPY`, no direct
   SQL); a failed batch bisects to isolate offending rows, which quarantine
   to `engine.import_reject` with reasons rather than aborting the object.
   Before each batch, normalize source identifiers (Salesforce 15-character
   ids become their canonical 18-character form) and apply the approved
   duplicate policy. v1 insert-only treats an existing primary/selected
   duplicate key as a reported duplicate, never a silent overwrite.
   Per-file row-count reconciliation against the manifest. Batch size is
   tuned by measurement — bulk-insert throughput vs `COPY` is a tracked
   risk (§7), not a design escape hatch.
4. **Registry finishing.** Relationships (from describe `referenceTo` or
   inferred), default layouts (detail: ≤2-column field groups in describe
   order; list: name + 5 most-used columns), permissions seeded from source
   profiles (collapsed to admin/member per D8; report notes what collapsed).
5. **Identity.** Run C10 mapping from the imported user object.
6. **Validate & report.** Row counts vs manifest, sampled checksums,
   dangling-reference counts, unmatched users, permission-collapse summary →
   persisted import report (briefing finding + `/a/[app]/admin`). Set
   `app_state.status='active'`, refresh `record_object.record_count`.

**Testing:** golden-fixture test with a miniature fake export (a dozen objects
incl. one `__c`, compound address, formula field, multipicklist, dangling
refs, a user CSV with one email collision); property tests for the CSV parser;
resume tests kill immediately before and after every target batch commit and
between stages, then assert no duplicates or missing rows; concurrent-run and
cancel/restart tests verify receipts, history, and diagnostics remain intact.

### C9 — First-party connector framework (Salesforce first)

**What:** "just connect and import everything" — and keep syncing where the
source API makes it feasible. A connector is worker-native code implementing
one interface against the C8 staging contract:

```
discover()  → object/field/count inventory (the migration plan)
export()    → full extraction into the artifact directory
delta(wm)   → changes since watermark, applied through the C4 executor
```

Each connector declares its **sync feasibility** from what the source API
offers — Salesforce: `SystemModstamp` watermarks + `queryAll` for deletes
(good); Zendesk: the incremental export APIs (good); a source with no
change-tracking API: export-only, honestly labeled. Apps fed by a connector
run in one of two modes, chosen at setup and switchable by approval:

- **Mirror mode** — ongoing scheduled inbound sync; the source system remains
  the system of record; local records are read-only (the agent can still
  query, watch, and brief over them — that's most of the value on day one).
- **Primary mode (cutover)** — sync stops (or winds down through a transition
  window), local writes open up, and the app is the system of record.

The natural adoption arc is mirror first, cutover when trust is earned.
Two-way write-back to the source is explicitly **out of scope** for v1 —
one-way inbound only, which is what makes mirror mode safe. Mechanically the
mode lives in `app_state.config.mode`; the C4 adapters and form routes refuse
writes on a mirror app with a typed error ("mirrored from Salesforce — writes
happen there until cutover"), while reads, watchers, and briefings work
unchanged.

**Salesforce connector** (`packages/records/src/connect/salesforce/`), run as
a pg-boss job with checkpointed state in `app_state.config.export`. Action
kinds: `salesforce_discover` (`auto`), `salesforce_export_start` (`ask`),
`salesforce_export_status` (`auto`), `salesforce_export_cancel` (`ask`),
`salesforce_sync_delta` (`ask` to enable the schedule; individual runs then
`auto` as `service`).

- **Auth:** Connected App client-credentials flow; `SALESFORCE_INSTANCE_URL` /
  client id in `app_state.config`, client secret in `data_source_secret`
  (enc:v1). The `salesforce_export_start` approval card states the outbound
  hosts (`*.salesforce.com`, `*.force.com`, `*.my.salesforce.com`) — the
  operator approves the egress along with the job.
- **Discover:** describe sweep → object/field/count inventory, rendered as the
  migration plan the admin approves before bulk export.
- **Export:** per object, submit a **Bulk API 2.0 query job**, poll, stream
  result CSV pages (`Sforce-Locator` pagination) into
  `data/<object>.csv` under a worker-owned staging directory — atomic per-page
  appends with a checkpoint (object, locator, rows written) so a killed worker
  resumes mid-object. PK-chunked fallback for objects past Bulk limits; plain
  REST for the small/unsupported tail. Persist `describe/*.json` and
  `export-manifest.json` (expected counts + the watermark delta sync resumes
  from), then chain into `records_import_start` (C8) — export and import
  reconcile counts independently.
- **Delta sync:** `SystemModstamp > watermark` (+ `queryAll` for deletes)
  from the manifest watermark; changes are applied **through the C4 executor**
  as the `service` actor (logged as `sync` in the change log) so even sync
  writes hit the one write path. Each target batch uses deterministic mutation
  ids; after all receipts succeed it advances `engine.sync_cursor`, keyed by
  connector instance + app + object and guarded by the batch hash. A crash
  before cursor advance safely replays already-receipted mutations; a cursor
  never advances over an unapplied change. `app_state.config` mirrors the
  watermark for status only. In mirror mode this runs on a schedule
  indefinitely; in primary mode it's the transition window that winds down at
  cutover. One-way inbound either way — never a write-back bridge.
- **Client discipline:** token caching/refresh, 429/`Retry-After` and
  `REQUEST_LIMIT_EXCEEDED` backoff, and a **daily API-budget governor**
  (job/batch limits and org API-call allowances tracked in checkpoint state;
  the job self-throttles rather than exhausting the quota their still-live
  Salesforce needs).
- **Staging hygiene:** 0700 directory on a worker-owned path, excluded from
  backups (re-derivable), deleted after the import report validates (the org
  remains the source of truth until cutover). Disk pre-flight covers staging
  *plus* DB footprint (~3× CSV bytes) before export starts; §6.4 watermark
  backpressure pauses the job like any bulk work.
- **Chat-first onboarding:** "create an app that will let me bring in my
  Salesforce data" → the agent walks the admin through Connected App setup →
  secret lands via `openneko secrets set` → `salesforce_discover` renders the
  plan card → one approval starts export → import chains → the briefing
  announces the app is live with validation + identity reports.

A Zendesk connector is the same interface with a different client (incremental
export APIs for delta, ticket/user/organization objects for describe) — the
"replace my Zendesk" path starts as a mirror-mode support app and earns
cutover.

**Testing:** mocked-SF-server harness covering the export end-to-end (Bulk job
lifecycle, locator pagination, kill/resume from checkpoint, manifest count
reconciliation, rate-limit backoff, budget-governor throttling) and the delta
job's watermark/resume.

### C10 — Identity mapping

**What:** source-instance-scoped `engine.identity_map` population + lazy
linking + admin surface. No external id is globally unique merely because its
source system says so.

- **At import:** for each imported user row, `lower(email)` match against
  `app_user` (active only) → `status='linked'`; no match → `'unlinked'`;
  email already bound to a conflicting link → `'conflict'`. Then backfill
  `owner_user_id` on every owned table via one UPDATE join per object.
- **Lazy linking:** hook the SSO upsert (`upsertUserFromIdentity`) — after a
  user row is created/attached, attempt `identity_map` linking for that email
  and backfill `owner_user_id` for newly linked users (worker job, not in the
  login request path).
- **Admin surface:** `/a/[app]/admin/identity` — list by status, manual
  link/ignore, re-run backfill. Mirrors the channel-identities settings page.
- **Agent access:** the mapping is readable through GraphJin (admin-role only)
  so chat can answer "who owned these accounts in Salesforce?" during
  transition.
- **Reference fidelity:** imported relationships retain their connector
  instance and source id. Salesforce polymorphic fields such as `WhoId` and
  `WhatId` populate `record_field.reference_targets` and resolve against the
  permitted target set; they are never collapsed to one guessed object.

**Testing:** unit tests for match/conflict states, two source instances with the
same external id, Salesforce 15→18 id normalization, and polymorphic reference
resolution; integration test that a fresh SSO sign-in links a previously
unlinked user and backfills ownership only for the intended source/app.

### C11 — Agent skills & blueprints

- **App-builder skill** `packages/llm/assets/builtin-skills/app-builder/SKILL.md`
  (pattern: the existing `graphjin-config` skill): how to interview for
  requirements and model a **novel domain from scratch** (entities →
  relationships → ownership → workflows; blueprints are priors, not limits),
  adapt a blueprint, propose `app_create` with a complete object/field set in
  one card, offer CSV mapping when the user mentions a spreadsheet (D14),
  evolve schemas additively, and when to counter-propose (lossy type change →
  add + backfill). **Proactive proposals** (D2d): when work memory shows the
  same ad-hoc view or hand-tracked list recurring, suggest an app — as a
  briefing finding or in-thread suggestion, never an unprompted approval
  card, and drop the suggestion cleanly if declined (no nagging). Hard rules:
  never propose `hard_drop` (it doesn't exist as an action); archived means
  hidden, not gone.
- **Records skill** `.../records/SKILL.md`: browsing the registry catalog,
  querying via GraphJin, proposing `record_*` actions — with the hard rule
  *resolve the record id via query first; never guess-and-write*,
  disambiguation guidance, and the `expected`-field concurrency idiom.
- **Domain packs as skills + blueprints:** the CRM pack (Salesforce object
  semantics, stage conventions, "owner" language → `owner_user_id`,
  import-report interpretation) and later a support-desk pack. Domain
  knowledge ships as skill text and blueprint JSON — never as engine code
  (§1.3).

**Testing:** skill lint via existing skills validation; scenario transcripts
in the worker's agent test harness for propose-flow correctness (app create
from blueprint; ambiguous record update → clarify).

### C12 — Watcher & briefing integration

**What:** make the payoff visible on day one. Ship (docs + optional seed
workflows, enabled by choice, blueprint-aware): "opportunities with no
activity in 30 days", "records owned by an unlinked/departed source user",
"deals closing this month by owner" — each a **`gj_watch` standing watch**
(durable cursors, absence detection where silence is the signal) delivering
into the worker via allowlisted webhook, with OpenNeko's scheduled-watch
path as the fallback trigger mode. The import report and app-creation
summary land as briefing findings.

**Testing:** seed workflows run green against the golden import fixture, in
both trigger modes (gj_watch-fired and scheduled).

### C13 — Backup, disk & ops resilience

**What:** the operational floor under C1, detailed in §6. Concretely:

- `compose.yml`: backup sidecar (pgBackRest) with WAL archiving + scheduled
  base backups for **both** `records-db` and `neko-db`; `records-db` gets its
  own named volume, healthcheck, and `restart: unless-stopped` matching the
  `neko-db` pattern.
- Worker: `QUEUE.RECORDS_BACKUP_VERIFY` (weekly restore-verification job),
  disk-watermark sampler feeding backpressure state, ops watcher seeds.
- CLI: records participates in the platform commands
  `openneko backup now|status` and `openneko restore --to <time>`; there is no
  competing records-only backup command. `openneko doctor` gains records
  connectivity, absolute/percentage disk headroom, backup-age, and WAL-archive
  checks.
- C8/C4/C3 integration: importer pre-flight headroom check; write-path and
  sync backpressure at watermarks; executor idempotency via
  `engine.action_execution` and target-side batch receipts; `hard_drop` CLI
  gated on a fresh verified backup.

**Testing:** kill/restart matrix in CI (compose harness): kill `records-db`
mid-write, fill a small test volume to ENOSPC during import, verify resume and
clean recovery; weekly verify job tested against the golden fixture backup.

---

## 5. Phases & acceptance criteria

**Phase 0 — Feasibility, security, and recovery spike (C1–C5, C7,
C13-core).**
Prove one seeded dynamic object end to end before building the broad product:
dedicated `records-db` + `records-graphjin`; DDL preview/hash/apply/reconcile;
JWT read policy; worker-service mutation with action receipt and audit trigger;
soft delete/restore; query budgets; encrypted backup/restore.
*Acceptance:* every §3.1 precondition has an automated proof. Kill the worker
at every schema-saga phase and recover to `projected`; mutate the catalog
between preview and apply and require re-approval; create an unknown/orphaned
table and prove every human operation is blocked; prove there is no
new-table exposure window; replay a multi-row action without duplicate effects;
hide deleted rows from every generated read; reject adversarial expensive
queries; restore both databases and configuration from a coherent backup and
run reconciliation. **No broader implementation proceeds until this gate is
green.**

**Phase 1 — First real app vertical slice (C6-M1, C8-CSV, C11-builder).**
"Create an app to track equipment loans" works end to end: conversation creates
a draft proposal; the operator reviews the high-level schema with no SQL;
approval provisions
the app; generated list/detail plus a minimal create/edit drawer make it usable;
scoped Ask writes use approval cards; a spreadsheet loads through the mapping
card.
*Acceptance:* 5k-row CSV import survives kills around every batch commit with
no missing/duplicate rows; member/admin visibility agrees in UI and chat;
archive and recycle-bin behavior work; hostile identifiers are rejected; the
M1 generated-content visual contract passes; a second adversarial equipment or
support fixture proves the renderer handles long labels, nulls, no ownership,
unknown picklists, hidden fields, and many fields with no app-specific code.

**Phase 2 — Salesforce mirror and cutover (C8-artifacts, C9, C10,
C11-crm-pack, C13-verify/watchers).**
Whole-system CSV-dump and connected import produce a CRM app with
source-scoped identity and an import report; mirror-mode delta sync runs until
an explicit cutover state machine freezes scheduling, applies a final delta,
verifies its watermark, and opens local writes.
*Acceptance:* mocked-SF export/import reconciles counts and survives kill/resume
at every stage; 15/18-character ids, duplicate keys, polymorphic references,
and identical ids from two connector instances resolve correctly; target-side
receipts make delta replay harmless; mirror writes reject clearly; API budgets
throttle; cutover cannot interleave sync and local writes; verified restore and
unlinked/conflict identity reporting are visible.

**Phase 3 — Full application ergonomics and scenario parity (C6-M2/M3,
C12).**
Complete generated forms, app pages, semantic saved views, permissions and
identity admin, schema history, and watcher/briefing seeds. The native Ask and
approval surfaces compose into generated apps without becoming registry data.
*Acceptance:* the full CRM mockup scenario passes visual and behavioral parity;
every field-kind form round-trips; a deny policy blocks form and agent paths;
an approved `app_layout_update` changes an `app_page`; saved views honor
user/org ownership; `gj_watch` resumes and skips self-writes; outage banners
are distinct from the quiet substrate strip.

**Phase 4 — Generality and scale-out.**
A second connector (Zendesk-shaped, mirror-first) proves the C9 interface;
shipped user-app blueprints become versioned toward a remote catalog;
navigation scales to hundreds of objects; per-app roles extend beyond
admin/member only when a real app demands them; ContentVersion/file import
follows. Native OpenNeko platform screens remain outside this roadmap.

---

## 6. Resilience & operations

> **Platform note:** the posture below is generalized to everything OpenNeko
> ships — see [RESILIENCE.md](RESILIENCE.md) for the platform baseline
> (whole-deployment backup unit incl. the config/secrets volumes, watermark
> backpressure, ops watcher pack, HA ladder). The records engine **inherits**
> that baseline; this section retains the engine-specific application. Where
> the two documents overlap, RESILIENCE.md is authoritative.

The engine holds business-critical daily-operations data on self-hosted,
often single-host infrastructure. The posture: **crash safety is Postgres's
job; ours is restart orchestration, idempotency, backups that are proven
restorable, disk headroom management, and honest degradation** — with an HA
ladder for clients who need more than a single host, and OpenNeko's own
watcher machinery monitoring the substrate it runs on.

### 6.1 Failure domains at a glance

| Failure | Effect without mitigation | Mitigation (component) |
|---|---|---|
| Container crash (web/worker/graphjin) | Requests fail until restart | Stateless services + `restart: unless-stopped` + healthchecks (exists); pg-boss jobs resume; no state lost |
| Container crash (`records-db`) | Reads/writes fail; no data loss | Postgres WAL crash recovery; healthcheck-gated dependents; fast restart (C13) |
| Worker dies mid-write | Half-applied action? | Each write is one atomic GraphJin mutation + same-transaction audit trigger (C4); action journal + retry (§6.3) |
| Worker dies mid-schema-change | Physical/registry/config state may differ | Durable schema saga + desired revision + preview hash + boot reconciliation (C3); never a cross-DB transaction |
| Worker dies mid-import / mid-export | Stuck or replayed migration | Target-side import/batch receipts (C8); deterministic mutations + target sync cursor; resumable export checkpoints (C9) |
| Disk full | Postgres PANICs; stack down | Attributable volume metrics, percentage + absolute-byte watermarks, backpressure, pre-flight checks (§6.4) |
| Volume/host loss | **Data loss** | Continuous WAL archiving + base backups + verified restore (§6.5) |
| Silent backup rot | Discovered at the worst moment | Weekly automated restore verification + backup-age watcher (§6.5) |
| GraphJin down | App reads *and* writes fail (one data plane) | Stateless restart; degraded UI banner; journaled action requests retry (§6.3); agent reports source unavailable (§6.6) |
| Human error (bad bulk update) | Corrupted operational data | Approval cards, change log, soft delete, PITR via WAL (§6.5, C4) |
| Agent error (bad schema proposal) | Wrong shape, not lost data | Approval cards on all schema actions; additive-by-default; archive-not-drop (D7); schema log + PITR |

### 6.2 Process & container crashes

What already exists and carries over: every long-lived service runs
`restart: unless-stopped` with healthchecks, dependents gate on
`service_healthy`, and migrations run as one-shot jobs
(`condition: service_completed_successfully`). `records-db` adopts the same
pattern (C1/C13). Web, worker, and GraphJin are stateless — a crash loses
nothing; in-flight pg-boss jobs re-run after their visibility timeout.
Postgres itself is crash-safe by construction (WAL + fsync); a `docker kill`
mid-transaction rolls back cleanly on restart.

### 6.3 Write-path durability & idempotency

The single-write-path decision (D6) is also the durability story:

- Every write — data or schema — exists first as an `action_request` row **in
  the metadata DB**, a durable journal independent of `records-db`. If
  `records-db` is down, the approval card and intent survive; execution fails
  fast with a typed error and is retried by pg-boss
  (`retryLimit`/`retryDelay`/`retryBackoff`, per-queue — the `CHANNEL_DELIVER`
  precedent uses 8 retries with exponential backoff).
- Retries must not double-apply: `engine.action_execution` atomically claims a
  command and stores its result. `engine.record_change_log` is intentionally
  one-to-many by action request; deterministic per-row `mutation_id` is its
  uniqueness backstop. Schema actions use the saga's unique action request and
  desired revision.
- Imports commit deterministic batch receipts beside their target inserts;
  delta sync uses deterministic mutation receipts and advances a target-side
  cursor only after all changes are proven. A crash replays harmlessly.

### 6.4 Disk exhaustion — the #1 self-hosted killer

Postgres on ENOSPC PANICs but does not corrupt: freeing space and restarting
recovers. The plan's job is to make that event rare and non-catastrophic:

- **Dedicated volume** for `records-db` (C1) so accounting and lifecycle are
  attributable. A named volume is not physical isolation: volumes commonly
  share the host filesystem, so unrelated logs/caches can still exhaust it.
- **Pre-flight checks:** the importer estimates footprint (~CSV bytes × 2 for
  heap + indexes + WAL; connected export adds staging bytes) and refuses to
  start below that headroom, telling the admin exactly how much is needed.
- **Watermarks with backpressure** (C13): an ops sidecar/exporter with the
  required host/volume mounts publishes filesystem metrics; the unprivileged
  worker consumes them rather than assuming it can inspect Docker volumes.
  Thresholds combine percentage and absolute free bytes, taking the more
  conservative result. At 80% — warning finding on the Briefing + channel
  alert. At 90% —
  degrade deliberately: pause delta sync, imports, and exports, refuse new
  bulk operations, keep interactive single-record writes alive until a hard
  stop at 95%. Recovery is automatic when space frees.
- **Hygiene:** `temp_file_limit` set, WAL retention bounded by the archiver
  (§6.5), autovacuum/bloat surfaced in `openneko doctor` and
  `records status`.

### 6.5 Backups — the redundancy floor (non-negotiable, Phase 0)

A single-host deployment's real redundancy is a **verified, off-volume
backup**:

- **Mechanism:** pgBackRest sidecar — continuous WAL archiving plus scheduled
  (default nightly) base backups, covering **both** `records-db` and `neko-db`
  (the action journal and app state live in the metadata DB; a restore needs
  a consistent pair, and cross-DB references are by-value for exactly this
  reason). Independent Postgres backups are not a distributed snapshot, so
  every backup set carries a global manifest: database recovery points,
  config revision/hash, saga/action/import high-water marks, and a short
  quiesce boundary where required. Restore reconciles C3/C5/import state
  before traffic opens. RPO with WAL archiving: minutes. Point-in-time recovery
  also covers the human-error *and agent-error* cases ("restore to just before
  the bad bulk update").
- **Targets:** an encrypted repository (with keys/access policy separate from
  the data volumes), local path / mounted NAS by default; S3/GCS configurable at
  setup. The backup target must be a different failure domain than the data
  volume — setup warns loudly when it isn't.
- **Restore:** platform `openneko restore --to <timestamp>` drives the runbook
  (stop dependents → restore → replay WAL → re-run doctor); documented for
  the full-host-loss case (fresh host + backup target = working stack).
- **Verification:** an unverified backup is a hope, not a backup. A weekly
  worker job restores the latest backup into a throwaway container, runs
  row-count and sampled-checksum sanity against the live DB's change-log
  high-water mark, and posts the result as a Briefing finding. A failing or
  stale verification is an alert, not a log line.
- **Import safety:** source CSVs/staging are retained until stage-6 validation
  passes, and the import report reminds the admin to keep the source export
  (or the source org) until the first *verified* backup exists.

### 6.6 Degradation & self-monitoring

- **Honest degradation:** when GraphJin or `records-db` is unreachable,
  `/a/*` renders an explicit degraded banner (no stale-cache pretending), the
  agent surfaces "records source unavailable" rather than hallucinating
  around it, and queued writes state that they are queued. Approvals never
  disappear — they live in the metadata DB.
- **OpenNeko watches itself** (C13 + C12): the same watcher machinery clients
  use on their business data ships an ops pack for the substrate — disk
  headroom, backup age and last verification result, WAL-archive failures,
  container restart counts, replication lag (when §6.7 Tier 1 is in play),
  import/export/sync job health. Findings land on the Briefing; alerts go out
  through installed channels. The engine monitoring its own database is the
  dogfooding story, and it removes the "nobody was watching the self-hosted
  box" failure mode.

### 6.7 The HA ladder

Redundancy beyond one host is a deployment tier, not an engine feature — the
engine only ever sees a Postgres connection string:

- **Tier 0 (default, single host):** restart policies + crash-safe Postgres +
  continuous verified backups. RPO minutes, RTO tens of minutes (restore
  runbook). Right answer for most small/mid deployments.
- **Tier 1 (warm standby):** streaming replication to a second host (async),
  lag watched by the ops pack, documented manual-promote runbook. RPO
  seconds, RTO minutes. Deliberately manual promotion — automated failover
  (Patroni-class) is out of scope for a compose-based stack and easy to get
  dangerously wrong.
- **Tier 2 (BYO / managed Postgres):** point `records-db` at RDS / Cloud SQL /
  the client's DBA-run HA cluster via a stored connection secret. The compose
  service is the default, not a requirement; skipping the sidecar for
  externally-managed databases hands backup responsibility over — `doctor`
  says so.

### 6.8 Data-lifecycle guards

Restated as the safety net they form: archiving an app or object **never
drops data** (D7); deletes are soft (recycle-bin semantics, C4);
hard-destructive operations (`hard_drop`, restore-overwrite) require typed
confirmation *and* a fresh-verified-backup check; every data write is
attributable in the change log and every schema change in the schema log,
each with its approving action request.

---

## 7. Risks & open questions

- **Agent-authored schema quality.** The approval card is the control point,
  but a plausible-looking bad schema (wrong kinds, missing relationships)
  costs rework. Mitigations: blueprints as strong priors, the app-builder
  skill's interview discipline, additive evolution making fixes cheap, and
  the counter-proposal path for lossy changes. M0 makes the draft app state
  (admin-visible, not live) explicit before schema approval.
- **GraphJin config churn.** Table exposure reloads with `db sync`, but
  role/permission projection still regenerates config on schema and
  permission actions. The records-specific config lock serializes writers;
  frequent regeneration on a busy build session needs debouncing and a
  reload-cost check against a live GraphJin. Measure in Phase 1.
- **GraphJin DDL expressiveness & version coupling.** C3 leans on GraphJin's
  schema-diff engine (pinned v3.18.x); its DDL format has edges we design
  around rather than bypass (arrays → `Jsonb`, schemas → prefixes+aliases,
  no defaults — [RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1), and
  index-on-existing-column is a documented limitation (upstream
  contribution candidate). The invocation surface has churned across
  versions (MCP tool → control-plane root → currently the `graphjin db`
  CLI), so C3 wraps it behind one module pinned to the shipped version, and
  version bumps gate on a schema-diff regression fixture.
- **Watch scale.** `gj_watch` evaluation is polling-based cursor
  subscriptions under the hood; latency and load at hundreds of standing
  watches need measurement (batched polling helps — one round-trip per
  ~5000 members on Postgres), and per-watch event retention/caps need
  tuning for busy apps. Scheduled-watch remains the fallback either way.
- **The role-config generator is security-critical.** The D8 model maps
  onto GraphJin's Table-permissions config, but exhaustiveness is
  load-bearing: a table omitted from the projection is *accessible*, not
  blocked, for non-anon roles. Live-catalog generation, the every-table × role
  × operation test, new-table readiness gate, and the C7 drift test are the
  safety net. Adding roles
  beyond admin/member later means new `roles_query` matches — cheap — but
  widening the actor model touches `engine.actor` sync.
- **Bulk-insert throughput.** Imports load through batched GraphJin array
  inserts rather than `COPY` (D6: one write plane). Postgres compiles each
  batch to a single statement, but a Salesforce-scale import (hundreds of
  thousands of rows) needs measured batch sizing and wall-clock validation
  in Phase 2's golden-fixture benchmark before real migrations run.
- **Records runs with the allow-list disabled.** Generated UI queries are
  dynamic, so the records GraphJin config opts out of saved-query
  enforcement. Deliberate and scoped to the standalone records instance, but
  safe only with C5's time/depth/complexity/row/aggregate/input/rate budgets
  and negative load tests in the security gate.
- **Dynamic-DDL hygiene.** `naming.ts` is the only path to an identifier and
  is security-sensitive (SQL injection via labels/CSV headers). Strict
  allowlist grammar + exhaustive tests + identifiers always quoted. Now
  doubly important since schema actions accept conversational input, not just
  CSV headers.
- **Worker egress visibility.** D11 moves connector traffic into the worker.
  The approval card names destinations, but a per-connector host allowlist
  enforced at the HTTP-client layer (not just documented) is the stronger
  posture — scoped for C9.
- **Very large source systems.** Beyond load throughput, GraphJin discovery
  over hundreds of tables must be measured. The UI uses search, favorites,
  recents, and collapsed groups rather than a flat rail; the Phase 4 fixture
  proves it remains usable.
- **Accidental multi-org enablement.** Rows carry `org_id`, which can look more
  capable than the physical layout is. Setup and runtime enforce one org per
  deployment in v1; any attempt to add another org fails with the D12
  explanation until tenant-safe physical naming/keys ship.
- **Type inference on describe-less CSV dumps.** Misjudged columns (all-empty
  fields) are corrected by the import-plan approval card — the admin sees
  inferred types before DDL; plan-edit is a Phase 2 stretch, visibility the
  minimum.
- **Email collisions & shared mailboxes.** `identity_map.status='conflict'`
  rows need a human; the report must make this loud — silent mis-ownership is
  the worst failure mode of a migration.
- **Proactive proposal noise (D2d).** An agent that suggests an app every
  time a pattern half-repeats erodes trust fast. The skill needs a high bar
  (recurrence over weeks, not sessions), one suggestion per pattern, and
  declined-means-dropped memory.
- **Page layer as a trust surface (D15/D16).** Agent-authored pages must be
  visually and structurally incapable of imitating approval cards or settings
  controls: block renderers are a closed set with their own chrome, and
  approval cards exist only in the native thread surface. Enforced by
  construction, verified by an e2e that tries.
- **Cutover ordering (C9).** Flipping mirror → primary while a delta run is
  in flight could interleave sync writes with first local writes. Cutover is
  a small orchestration: freeze the schedule → run a final delta → verify
  watermark → open writes. Scoped into C9, tested in the mocked-SF harness.
