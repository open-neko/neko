# Records Engine & Apps — Implementation Plan

**Scope:** a native OpenNeko records engine on which the **agent builds "apps"** —
a CRM is an app, a Zendesk-style support desk is an app, an inventory tracker is
an app. "Create an app that will let me bring in my Salesforce data" and "create
an app to help me replace Zendesk" are the product sentences this plan
implements. The agent designs the schema in conversation, the engine applies it,
the UI is generated from metadata, GraphJin serves reads and change
subscriptions, and access follows the established user/role pattern.

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

There is no app store and no app SDK. An app is **registry content**: objects,
fields, relationships, layouts, permissions — created and evolved through the
same propose → approve → execute → audit action stack every other OpenNeko
mutation uses. "Add a `warranty_expires` date to equipment" is an approval card,
not a migration PR. Starter **blueprints** (CRM, support desk, …) ship as data
the agent adapts in conversation, never as code paths. This is what makes the
roadmap (CRM → support → marketing → ERP) cheap: each next domain is a
conversation plus a feeder, not an engineering project.

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

---

## 2. Decisions

Each decision records what was chosen, why, and what was rejected — including
two reversals of the previous draft of this plan.

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
+ a dedicated Postgres schema in `records-db`. Apps come into existence four
ways, all converging on the same schema executor (C3): (a) **conversation from
scratch** — including apps that have never been built before; blueprints are
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

**D5 — All reads through GraphJin with per-actor JWTs; watching via GraphJin
subscriptions.**
`records-db` is registered as a data source with `auth_mode: 'jwt'` (migration
`0036_data_source_auth_mode.sql`). Chat runs already mint HS256 actor tokens
(`packages/llm/src/graphjin/token.ts`: `sub` = userId, `role` ∈
admin|member|service, 5-min TTL, per-org derived secret). The web UI's `/a/*`
pages mint the same tokens for the signed-in user — **no second SQL read path**.
Watchers read as `service`, and change-watching uses GraphJin's subscription /
live-query support over the same role config where enabled, falling back to the
existing scheduled-watch path. **Schema creation also goes through GraphJin:**
GraphJin ships a declarative schema facility — GraphJin DDL desired-state files
(`db.ddl` / per-source `schema-ddl/*.ddl`), a schema-diff engine
(`core/schema_diff.go`) that generates create/alter SQL against the live
database (Postgres: fully supported), and a `preview_schema_changes` /
`apply_schema_changes` surface gated by `mcp.allow_schema_updates`, with drops
requiring an explicit `destructive` flag and an automatic schema reload after
apply. Nobody on our side authors SQL for schema changes — not the agent, not the
executor. The C3 executor projects the registry into a GraphJin DDL document
(GraphQL-style `type` definitions) and drives GraphJin's schema machinery:
**GraphJin internally diffs, generates, and transactionally executes the
SQL.** Source audit ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1): at the
pinned version the MCP/control-plane preview-apply surface is removed, so the
live invocation is the shipped binary — `graphjin db diff` produces the SQL
delta the approval card displays, `graphjin db sync --yes` applies it in one
transaction with rollback-on-error. The artifact of record is the GraphJin
DDL document plus the diff output.

**Records GraphJin configuration:** because `records-db` is our own built-in
database — not a customer's — it does **not** run `read_only`. It is
configured `analytics_mode: true` (no implicit row limits, so aggregate
queries for reports and D15 metric blocks return complete results) **plus
mutations- and DDL-capable** — `read_only` blocks all mutations and DDL, so
C3 requires it off. The single-write-path guarantee (D6) is enforced at the
**role level** instead of the source level, and the source audit
([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §2) pins how: GraphJin's
source-mode generated access rules cannot express per-object per-role CRUD
grants, so the records configuration uses GraphJin's **legacy role model,
generated by C7** — an exhaustive per-object × per-role × per-operation
`roles:` block (explicit `block: true` on every mutation for `admin` and
`member`, row filters like `{ owner_user_id: { eq: $user_id } }` on
owner-visibility tables, full grants for `service`), with role resolution
via `roles_query` against an engine-maintained actor table
(`engine.actor`, synced from `app_user`). Exhaustiveness is a security
invariant: in legacy mode an omitted table means unrestricted access for
non-anon roles. `service` credentials exist only in the worker for the
C3/C4 executors. Because the legacy and source models cannot mix in one
config, records runs apart from the customer-data source-mode config (own
instance by default, following the `neko-graphjin` precedent). Customer
data sources are untouched: their source-mode analytics config keeps
`read_only: true` exactly as today. *Rejected:* direct SQL from Next.js API
routes (second enforcement point, guaranteed drift); hand-rolled DDL
generation in the engine (GraphJin already maintains the dialect + diff
engine); `read_only` on the records source (blocks the C3 apply path);
source-mode access rules for records (cannot express the D8 grant model).

**D6 — All writes through core action adapters — data writes *and* schema
writes.**
Data: `record_create` / `record_update` / `record_delete`. Schema: `app_create`
/ `app_object_create` / `app_field_add` / `app_field_modify` /
`app_object_archive` / `app_permission_set` / `app_layout_update` — all
registered with `registerActionAdapter` in the worker (the `user_admin` /
`data_source_admin` precedent in `apps/worker/src/plugins/manage-adapters.ts`).
Chat proposes → approval card → execute. UI forms create pre-approved requests
through the same executor. Every data write validates against the registry,
checks RBAC as the acting user, appends to `engine.record_change_log`, and
records into `workflow_run.source_writes` (migration `0021`) so watcher
cycle-checks keep working. Every schema write appends to
`engine.app_schema_log` with the submitted GraphJin DDL and preview response. The executors write with
**direct SQL in their own transaction** — the record write and its change-log
append are mixed operation types, which one GraphJin mutation cannot combine
atomically over HTTP ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §3) — so
GraphJin is the read/subscription/DDL plane while the write path's atomicity
lives in the executor (plus `COPY` for bulk loads). *Rejected:*
GraphJin mutations from agent- or user-facing roles (bypasses approval cards
and validation — blocked in-engine by the C7 role projection); a separate
"migration" pipeline for schema changes (two write paths again).

**D7 — Schema evolution is additive-by-default; the agent can never destroy
data.**
The safety profile that makes agent-authored DDL acceptable: `api_name`s are
immutable (labels are freely editable — "rename" is a label change); adding
objects/fields is the normal path (`ask` mode); type changes apply only when a
lossless cast exists, otherwise the executor proposes add-column + backfill;
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
(`org` | `owner`) enforced as GraphJin row filters
(`owner_user_id = $sub OR role = admin`). **Explicitly deferred:** role
hierarchy, sharing rules, territories — the complexity clients are fleeing.
Import reports show exactly what collapsed. *Rejected for v1:* a faithful
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
CSV loading needs direct `records-db` access and hours of COPY throughput;
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

**D12 — Org scoping everywhere.**
All engine and app tables carry `org_id` matching core conventions, even
though deployments today are effectively single-org. Cheap now, painful later;
the GraphJin JWT already carries `org_id` claims for filter generation.

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

**D15 — Apps have pages; shipped screens can become built-in apps.**
The generated UI is not only CRUD. An app can declare **pages** —
compositions of query-driven blocks (metric card, list, feed/timeline) stored
as registry content (`record_layout kind='page'`; definition = blocks of
`{label, query, renderer, span}`) and rendered by one generic page renderer,
every block's query running under the viewer's JWT like any read (D5). That
makes "why hardcode screens?" the right question: a CRM overview with
pipeline metric cards is registry data the agent can create and evolve, not
code. And since the metadata DB is already served by its own GraphJin
instance, core read surfaces are candidates for re-expression as **seeded,
non-archivable built-in apps** — the home dashboard (metric cards + briefing
feed) first. Two boundaries hold this together: (1) **control-plane surfaces
stay code** — setup, settings, approvals, and action cards must never be
definable by data the agent can write (an agent-authored page must not be
able to imitate or alter an approval card); (2) **sequencing discipline** —
the page layer lands when the first real app needs an overview page, and a
core screen is re-expressed only when doing so *deletes* the hardcoded
version, never as a parallel implementation. *Rejected:* a widget/plugin SDK
for pages (blocks are a fixed renderer set the engine grows deliberately);
rewriting existing screens as apps before the page layer has proven itself on
app-native pages.

**D16 — Screen taxonomy, decided now: native, built-in app, or on-demand app.**

| Tier | Surfaces | Rationale |
|---|---|---|
| **Native code** | Setup wizard; Settings (users, secrets, sources, plugins, health); approval cards & the action stack UI; the Work/chat thread surface; the nav shell | The control plane and the trust surface: these mutate platform state, render approvals, or *are* the agent interface. Never definable by data the agent can write (D15 boundary). |
| **Built-in apps** (seeded, non-archivable registry content) | Home dashboard (metric cards + briefing feed) — first candidate; findings and workflow-run browsers as later page-layer candidates | Read views over the metadata GraphJin instance. Being registry content makes them agent-tunable ("add a card for open deals to my dashboard") like any app page. Re-expressed only under the D15 rule: the hardcoded version is deleted, not duplicated. |
| **On-demand apps** | CRM, support desk, and anything the user + agent decide to build (D2a–d) | Business domains: records + pages, per app. |

**Shipping apps on demand:** because an app is data, a vendor-shipped app is
a **versioned app definition** — blueprint JSON + optional connector reference
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
| C1 | `records-db` service & provisioning | `compose.yml`, `db/records/` | 1 |
| C2 | Engine metadata registry | `db/records/migrations/`, `packages/records/` | 1 |
| C3 | App builder — schema action adapters + DDL executor | `apps/worker/src/records/schema/`, `packages/records/` | 1 |
| C4 | Record write path (`record_*` adapters) | `apps/worker/src/records/` | 1 |
| C5 | GraphJin integration (source, roles, tokens, subscriptions) | `packages/llm/src/graphjin/`, `packages/records/src/policy/` | 1 |
| C6 | Auto-generated web UI (`/a/[app]`) | `apps/web/src/app/a/` | 1 (read) / 3 (forms) |
| C7 | RBAC policy module (shared read/write source of truth) | `packages/records/src/policy/` | 1 |
| C8 | Importer — baseline CSV import (every app) + staged-artifact import | `packages/records/src/import/`, worker job | 1 (CSV) / 2 (artifacts) |
| C9 | First-party connector framework + Salesforce connector (mirror/cutover sync) | `packages/records/src/connect/` | 2 |
| C10 | Identity mapping (source users ↔ `app_user`) | `packages/records/src/identity/` | 2 |
| C11 | Agent skills & blueprints (app-builder, records, domain packs) | `packages/llm/assets/builtin-skills/` | 1–2 |
| C12 | Watcher/briefing integration & change subscriptions | worker + seeds + docs | 3 |
| C13 | Backup, disk & ops resilience (see §6) | compose sidecar, worker jobs, CLI | 1 (backup) / 2 (verify + watchers) |

Dependency spine:
C1 → C2 → C3 → {C4, C5} → C6(read) → C6(forms);
C8 depends on C3 (imports *are* app creation) and feeds C10; C9 feeds C8's
contract; C11 rides C3/C4; C12 rides C5. C13 depends only on C1 and lands with
it — business-critical data is never live without a backup path.

---

## 4. Component implementation plans

### C1 — `records-db` service & provisioning

**What:** a dedicated Postgres container for business data, plus lifecycle
plumbing.

- `compose.yml`: add `records-db` (postgres:16, own named volume, healthcheck,
  password provisioned like `neko-db`'s and rotated via `/setup`). Lazily
  provisioned: not started until the first app is created, so the default stack
  is unchanged.
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
    status     text NOT NULL DEFAULT 'provisioning',
      -- provisioning | importing | active | archived
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

Registry DDL (abridged; all tables carry `org_id`):

```sql
CREATE TABLE engine.record_app (
  app_id text NOT NULL, org_id text NOT NULL,
  label text NOT NULL, purpose text,        -- the sentence the app was created from
  status text NOT NULL DEFAULT 'provisioning',
  nav_order int NOT NULL DEFAULT 0,
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
  picklist_values jsonb,                       -- [{value,label,active}]
  reference_object text,                       -- api_name of target (kind=reference)
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
  changes jsonb NOT NULL,                  -- {field: {from, to}}
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON engine.record_change_log (org_id, object_api_name, record_id, at DESC);
CREATE UNIQUE INDEX ON engine.record_change_log (action_request_id)
  WHERE action_request_id IS NOT NULL;     -- §6.3 idempotency

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
  source_user_id text NOT NULL,            -- e.g. 18-char SF user id
  source_email text NOT NULL, source_name text, source_is_active boolean,
  app_user_id text,                        -- null until linked
  status text NOT NULL DEFAULT 'unlinked', -- linked|unlinked|conflict|ignored
  linked_at timestamptz,
  PRIMARY KEY (org_id, source_user_id)
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
| `app_create` | `ask` | registry app row + `CREATE SCHEMA` + `app_state` row; body carries the full initial object/field set so **one approval card shows the whole proposed app** |
| `app_object_create` | `ask` | registry rows + `CREATE TABLE` (+ indexes, `nk_*` audit columns, `owner_user_id` when owned) |
| `app_field_add` | `ask` | registry row + `ALTER TABLE ... ADD COLUMN` |
| `app_field_modify` | `ask` | label/picklist/required/layout tweaks (registry-only), or type change **only via lossless cast**; else the adapter returns a counter-proposal (add + backfill) for the agent to propose instead |
| `app_object_archive` / field archive | `ask` | sets `archived_at`; hides from UI/agent/GraphJin projection; **no DDL, no data loss** |
| `app_permission_set` | `ask` | updates `record_permission`; triggers C5 role regeneration |
| `app_layout_update` | `auto` | layout JSON only — no schema or policy effect |

Executor rules (one transaction against `records-db` per action, mirrored to
`app_state` in the metadata DB after commit):

1. Everything named passes through `naming.ts`; identifiers are always quoted.
2. The executor projects the registry delta into a **GraphJin DDL document**
   (desired-state `type` definitions — no SQL authored anywhere in OpenNeko)
   and drives the shipped binary: `graphjin db diff` renders the SQL delta
   for the approval card, `graphjin db sync --yes` applies it in one
   transaction with rollback-on-error, and the schema reloads so new tables
   are queryable (role/permission projection still regenerates under
   `acquireGraphjinConfigLock`). Destructive mode is **never enabled** —
   archive semantics (D7) mean the engine never asks GraphJin to drop
   anything, and the diff engine is additive-only regardless
   ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1). Schema conventions in
   the DDL doc: PK `id: Text! @id` (imported apps keep source IDs,
   from-scratch apps default to UUID-as-text), `@index` on reference columns
   and the name field, `multipicklist → Jsonb` (Postgres arrays are
   inexpressible in GraphJin DDL), **no `@default`** (unsanitized
   passthrough — defaults are write-path behavior), **no FK constraints**
   (integrity reported, not enforced — legacy data has dangles). The
   **engine residue path** (our SQL, our transaction, same `app_schema_log`)
   covers what the DDL/diff cannot: type migrations (add + backfill),
   index-on-existing-column, array/`text[]` needs, not-null changes.
3. Registry write + `app_schema_log` append commit together, recording the
   submitted GraphJin DDL and GraphJin's preview response; `app_state`
   mirror updates after apply.
4. Approval-card rendering: the adapter runs the preview at propose time —
   the card shows the GraphJin DDL delta plus the generated SQL GraphJin
   returned, so the admin approves exactly what GraphJin will execute.
5. `hard_drop` is **not an action kind**. It exists only as
   `openneko records drop --app X --object Y` with typed confirmation and a
   fresh-verified-backup check (D7).
6. Gating: the records configuration runs `analytics_mode: true` +
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
`naming.ts`; schema-log/DDL correspondence; concurrent app-create races
(second one fails cleanly on the registry unique).

### C4 — Record write path

**What:** the data-side adapters — `record_create` / `record_update` /
`record_delete` in `apps/worker/src/records/adapters.ts`, registered alongside
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

Executor steps, in order, all inside one transaction against `records-db`:

1. Resolve registry entry (object + fields, non-archived); unknown → typed
   error.
2. **Validate** from `record_field`: kinds, required (create only), picklist
   membership, length/scale, `read_only` rejection, reference-target existence
   (warn-not-block for legacy dangles, block for new dangles).
3. **RBAC** (C7): acting user's role + `record_permission` CRUD grant +
   ownership rule for `visibility='owner'` objects. Actor comes from the
   action request's actor snapshot.
4. **Optimistic concurrency:** `record_update.expected` (optional map of
   field → expected-current-value) guards chat races; mismatch → typed error
   the agent can re-plan on.
5. Write; stamp `nk_updated_by/at` (`nk_created_*` on create); soft-delete via
   `nk_deleted_at` (recycle-bin semantics; hard delete admin-only, later).
6. Append `engine.record_change_log` with field-level diff and
   `action_request_id` (unique-index idempotency, §6.3).
7. Return the outcome; the workflow layer records `(table, pk)` into
   `workflow_run.source_writes` for the subscription cycle-check.

Default `action_policy` seeding on app creation: create/update/delete → `ask`
(operators can rule-in `auto` for safe classes, e.g. activity logging).

**UI form path:** `/a/*` form submits POST to a records API route that creates
the action request pre-approved (actor = session user, noted "form submit")
and awaits execution — one executor, one log; a `deny` policy blocks forms
too, which is correct.

**Testing:** extend the `action-flow` pattern for the three kinds: validation
failures, RBAC denials, concurrency conflict, change-log diff correctness,
`source_writes` recording, soft delete, replay idempotency.

### C5 — GraphJin integration

**What:** register `records-db` as a jwt-mode source; project policy into role
config; serve reads and change subscriptions.

- **Registration:** on first app creation, drive the existing
  `register_source` machinery (`persistGraphjinSourceConfigUpdate` under
  `acquireGraphjinConfigLock`) with a `database` source named `records`,
  connection secret via `data_source_secret`, `auth_mode: 'jwt'`, signing
  secret from `graphjinSigningSecretB64(orgId)`. Approval-gated like every
  source change.
- **Role generation (C7 output):** `packages/records/src/policy/graphjin.ts`
  projects `record_permission` + `record_object.visibility` into GraphJin's
  **legacy-mode `roles:` config** (D5,
  [RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §2): per role × per table, all
  five operations explicit — `admin`/`member` get query grants with column
  lists and `block: true` on every mutation (the D6 write path is
  role-enforced); row filter `"{ owner_user_id: { eq: $user_id } }"` on
  `visibility='owner'` tables for `member` ($user_id resolves from the JWT
  `sub`); `service` reads everything and is the one mutation-capable role,
  its credentials held only by the worker. Role resolution via `roles_query`
  against `engine.actor` (user → role, worker-synced from `app_user`).
  **The projection is exhaustive by construction** — in legacy mode an
  omitted table grants access, so a generator test asserts every registry
  object appears for every role on every regeneration. Archived
  objects/fields are excluded from the projection (and blocked explicitly,
  not omitted). Regenerated on every C3 schema action and
  every permission change.
- **Subscriptions (the "watch" in the rethink):** GraphJin's live-query /
  subscription support runs over the same role config, so a watcher
  subscribing to `opportunities where stagename = 'Negotiation'` is enforced
  identically to a one-shot query. Semantics are **polling-based and
  at-most-once** — a slow consumer can permanently lose an update after the
  cursor advances ([RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §3) — so the
  subscription trigger is a *freshness optimization*: the scheduled-watch
  path remains authoritative, `subs_poll_duration` is set explicitly (the
  unset default is a 200ms floor, not 5s), and `workflow_run.source_writes`
  keeps self-triggering loops broken in both modes. GraphJin's durable
  `gj_watch` event layer is a C12 evaluation candidate.
- **Web tokens:** helper for `/a/*` API routes minting
  `mintGraphjinToken({orgId, userId, role})` from the session — same claims
  shape the agent path uses.

**Testing:** config-generation snapshot tests (permission fixtures → YAML);
live-GraphJin integration test asserting member-vs-admin row visibility on an
`owner`-visibility table; subscription smoke (insert via executor → subscribed
watcher fires; write from the same run → cycle-check suppresses).

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
/a/[app]/[object]/new          → create form (generated)
/a/[app]/[object]/[id]/edit    → edit form (generated)
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
- **Page renderer (D15, Phase 3):** one generic component walking a
  `record_layout kind='page'` definition — block renderers for metric card,
  list, and feed/timeline to start; each block's query is registry-generated
  and runs under the viewer's JWT. Layout edits arrive via the
  `app_layout_update` action ("add a card for open deals to my dashboard").
- **The ask-box** (the differentiator): every list and record view embeds a
  chat entry pre-scoped with app/object/record context (routes into the
  existing work-thread machinery with a context preamble). "Log yesterday's
  call, push close date two weeks" → agent proposes `record_update` → the
  approval card renders inline in the thread, consistent with `/work`.
  Schema-change proposals render the same way — "add a T-shirt-size field to
  deals" is an approval card in the same thread.
- **Nav integration:** app sections injected into the app shell nav from
  `record_app` + `app_state`, after Briefing/Work.
- **Change-log timeline** on record detail reads `engine.record_change_log`;
  the admin schema-history page reads `engine.app_schema_log`.

**Testing:** component tests for the field-widget matrix; e2e against a seeded
mini-registry: nav gating, list filtering, detail related-lists, form
round-trip through the action path, member-vs-admin visibility.

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
provenance in `app_state.config`) with the import report as the audit — the
change log stays useful instead of drowning.

Pipeline stages (each checkpointed in `app_state.config.import` so a restart
resumes; progress via `records_import_status` and a briefing card):

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
3. **Load.** Stream each CSV through `COPY ... FROM STDIN` in batches;
   RFC-4180 with embedded newlines; empty-string → NULL except genuinely empty
   text; source datetime/boolean literal handling; per-file row-count
   reconciliation against the manifest. Failures quarantine rows to
   `engine.import_reject` with reasons rather than aborting the object.
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
resume test (kill between stages, re-run, assert idempotence — every stage
`ON CONFLICT`-safe / `IF NOT EXISTS`-guarded).

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
  writes hit the one write path. In mirror mode this runs on a schedule
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

**What:** `engine.identity_map` population + lazy linking + admin surface.

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

**Testing:** unit tests for match/conflict states; integration test that a
fresh SSO sign-in links a previously unlinked user and backfills ownership.

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
"deals closing this month by owner" — each scoped through the `service`
GraphJin role, subscription-triggered where C5 subscriptions are enabled,
scheduled otherwise. The import report and app-creation summary land as
briefing findings.

**Testing:** seed workflows run green against the golden import fixture, in
both trigger modes.

### C13 — Backup, disk & ops resilience

**What:** the operational floor under C1, detailed in §6. Concretely:

- `compose.yml`: backup sidecar (pgBackRest) with WAL archiving + scheduled
  base backups for **both** `records-db` and `neko-db`; `records-db` gets its
  own named volume, healthcheck, and `restart: unless-stopped` matching the
  `neko-db` pattern.
- Worker: `QUEUE.RECORDS_BACKUP_VERIFY` (weekly restore-verification job),
  disk-watermark sampler feeding backpressure state, ops watcher seeds.
- CLI: `openneko records backup now|status|restore --to <time>`;
  `openneko doctor` gains disk-headroom, backup-age, and WAL-archive checks.
- C8/C4/C3 integration: importer pre-flight headroom check; write-path and
  sync backpressure at watermarks; executor idempotency via the
  `record_change_log.action_request_id` unique index; `hard_drop` CLI gated on
  a fresh verified backup.

**Testing:** kill/restart matrix in CI (compose harness): kill `records-db`
mid-write, fill a small test volume to ENOSPC during import, verify resume and
clean recovery; weekly verify job tested against the golden fixture backup.

---

## 5. Phases & acceptance criteria

**Phase 1 — The engine and the app builder (C1–C7, C8-CSV, C11-builder,
C13-backup).**
"Create a simple app to track equipment loans" works end to end: the agent
proposes the app (one approval card), the schema is applied and logged, the
app appears in nav with generated list/detail views, records are created and
updated through chat with approval cards, **a spreadsheet loads into it via
the CSV mapping card** (chat attachment or admin upload), RBAC separates
admin from member, and the change log shows everything.
*Acceptance:* blueprint-fixture app create → CRUD → browse passes as e2e; a
5k-row CSV imports into an existing object with unmatched-header field
suggestions, quarantined-row report, and correct duplicate detection, from
both chat and admin upload; member vs admin see different rows on an
owner-visibility object in both UI and chat; hostile-label identifier
injection rejected; archive hides but retains; WAL archiving + base backup
running against both databases and a manual restore drill documented and
executed once — **no real business data before the backup path works**.

**Phase 2 — Salesforce liberation (C8-artifacts, C9, C10, C11-crm-pack,
C13-verify/watchers).**
Both connector-grade feeders live: whole-system CSV-dump import and connected
import ("create an app that will let me bring in my Salesforce data"),
producing a CRM app with identity mapping and import report; **mirror-mode
ongoing sync** and primary-mode cutover with a transition window.
*Acceptance:* golden fixture import completes resumably and is idempotent;
mocked-SF full export → import chain completes hands-free from one approval,
reconciles counts, survives kill/resume at every stage; a mirror-mode app
rejects local writes with the typed error while chat reads/watchers work;
delta runs apply through the C4 executor as `service` and don't re-fire
watchers; cutover flips the mode by approval and opens writes; API budget
governor demonstrably throttles; weekly restore-verification job green and
alerting through a channel; unlinked/conflict identity report visible.

**Phase 3 — App ergonomics (C6-forms + pages + admin, C12).**
Generated create/edit forms on every object through the same action path;
the D15 page layer with an app overview page on the CRM blueprint;
permissions admin; identity admin; schema-history page; saved list views;
watcher/briefing seeds (subscription-triggered where enabled).
*Acceptance:* e2e create/edit/delete round-trips per field kind; a `deny`
policy blocks the form path too; an `app_layout_update` adds a metric card to
an app page and it renders under the viewer's JWT; permission edit
regenerates GraphJin config and the drift test stays green; seed watchers
fire on subscribed changes and skip self-writes.

**Phase 4 — Second feeder, built-in apps & scale-out.**
A second connector (Zendesk-shaped, mirror-first) proving the C9 interface
generic; the first core-screen re-expression as a built-in app (home
dashboard, under the D16 delete-not-duplicate rule); the shipped-app
definition format versioned toward a remotely-updatable catalog; saved view
sharing; per-app role extensions beyond admin/member if a real app demands
them (D3 discipline); ContentVersion/file import.

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
| Worker dies mid-write | Half-applied action? | Single transactional write path (C4); action journal + retry (§6.3) |
| Worker dies mid-schema-change | Half-created app? | C3: registry + DDL + schema log commit in one transaction; `app_state` mirror updated after commit; re-run is `IF NOT EXISTS`-safe |
| Worker dies mid-import / mid-export | Stuck migration | Checkpointed idempotent stages (C8); export checkpoints + resumable Bulk pagination (C9) |
| Disk full | Postgres PANICs; stack down | Dedicated volume, watermarks + backpressure, pre-flight checks (§6.4) |
| Volume/host loss | **Data loss** | Continuous WAL archiving + base backups + verified restore (§6.5) |
| Silent backup rot | Discovered at the worst moment | Weekly automated restore verification + backup-age watcher (§6.5) |
| GraphJin down | App reads fail | Stateless restart; degraded UI banner; agent reports source unavailable (§6.6) |
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
- Retries must not double-apply: `engine.record_change_log` carries a
  **unique index on `action_request_id`**, checked inside the write
  transaction — a replayed action becomes a no-op returning the original
  result. Schema actions get the same guard via `app_schema_log`.
- Delta sync applies through the same executor, so a crashed sync run resumes
  from its watermark and re-applies safely.

### 6.4 Disk exhaustion — the #1 self-hosted killer

Postgres on ENOSPC PANICs but does not corrupt: freeing space and restarting
recovers. The plan's job is to make that event rare and non-catastrophic:

- **Dedicated volume** for `records-db` (C1), so a runaway container log or
  model cache elsewhere cannot starve the database, and so disk accounting is
  attributable.
- **Pre-flight checks:** the importer estimates footprint (~CSV bytes × 2 for
  heap + indexes + WAL; connected export adds staging bytes) and refuses to
  start below that headroom, telling the admin exactly how much is needed.
- **Watermarks with backpressure** (C13): a worker sampler tracks volume
  usage. At 80% — warning finding on the Briefing + channel alert. At 90% —
  degrade deliberately: pause delta sync, imports, and exports, refuse new
  bulk operations, keep interactive single-record writes alive until a hard
  stop at 95%. Recovery is automatic when space frees.
- **Hygiene:** `temp_file_limit` set, WAL retention bounded by the archiver
  (§6.5), autovacuum/bloat surfaced in `openneko doctor` and
  `records status`.

### 6.5 Backups — the redundancy floor (non-negotiable, Phase 1)

A single-host deployment's real redundancy is a **verified, off-volume
backup**:

- **Mechanism:** pgBackRest sidecar — continuous WAL archiving plus scheduled
  (default nightly) base backups, covering **both** `records-db` and `neko-db`
  (the action journal and app state live in the metadata DB; a restore needs
  a consistent pair, and cross-DB references are by-value for exactly this
  reason). RPO with WAL archiving: minutes. Point-in-time recovery also
  covers the human-error *and agent-error* cases ("restore to just before the
  bad bulk update").
- **Targets:** local path / mounted NAS by default; S3/GCS configurable at
  setup. The backup target must be a different failure domain than the data
  volume — setup warns loudly when it isn't.
- **Restore:** `openneko records restore --to <timestamp>` drives the runbook
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
  the counter-proposal path for lossy changes. Watch item: whether Phase 1
  needs a "draft app" state (visible to admin only) before go-live.
- **GraphJin config churn.** Table exposure reloads automatically after
  `apply_schema_changes`, but role/permission projection still regenerates
  config on schema and permission actions. `acquireGraphjinConfigLock`
  serializes writers; frequent regeneration on a busy build session needs
  debouncing and a reload-cost check against a live GraphJin. Measure in
  Phase 1.
- **GraphJin DDL expressiveness & version coupling.** C3 leans on GraphJin's
  schema-diff engine (pinned v3.18.x), whose diff is additive-only and whose
  DDL format has real gaps (no arrays, no schema qualification, no defaults
  we'd trust — [RECORDS_GRAPHJIN.md](RECORDS_GRAPHJIN.md) §1). The
  engine-applied residue path covers type migrations and
  index-on-existing-column — keep it short and tested. The invocation
  surface has churned across versions (MCP tool → control-plane root →
  currently the `graphjin db` CLI), so C3 wraps it behind one module pinned
  to the shipped version, and version bumps gate on a schema-diff regression
  fixture.
- **GraphJin subscription semantics.** Live queries are polling-based under
  the hood; latency and load characteristics at hundreds of watched queries
  need measurement before subscription-triggered watchers become the default
  (scheduled-watch remains the fallback either way).
- **Legacy-mode role config is a security-critical generator.** The D8 model
  fits GraphJin's legacy role model, but exhaustiveness is load-bearing: an
  object omitted from the projection is *accessible*, not blocked, for
  non-anon roles. The generator test (every object × role × operation
  present) and the C7 drift test are the safety net. Adding roles beyond
  admin/member later means new `roles_query` matches — cheap — but widening
  the actor model touches `engine.actor` sync.
- **Records runs with the allow-list disabled.** Generated UI queries are
  dynamic, so the records GraphJin config opts out of saved-query
  enforcement and leans entirely on role config + JWT. Deliberate, but it
  must be scoped to the records configuration only and stated in the C5
  security review.
- **Dynamic-DDL hygiene.** `naming.ts` is the only path to an identifier and
  is security-sensitive (SQL injection via labels/CSV headers). Strict
  allowlist grammar + exhaustive tests + identifiers always quoted. Now
  doubly important since schema actions accept conversational input, not just
  CSV headers.
- **Worker egress visibility.** D11 moves connector traffic into the worker.
  The approval card names destinations, but a per-connector host allowlist
  enforced at the HTTP-client layer (not just documented) is the stronger
  posture — scoped for C9.
- **Very large orgs.** COPY throughput is fine, but GraphJin schema discovery
  over hundreds of tables and the UI nav both need `record_count`/usage
  ordering to stay usable. Watch item, not a blocker.
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
