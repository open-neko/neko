# Records Engine & CRM Module — Implementation Plan

**Scope:** Salesforce → OpenNeko CRM as the first shipped module of a domain-neutral
records engine, with marketing tools and ERP as follow-on modules. Input for v1 is a
full Salesforce export (every SObject as CSV, plus describe metadata where available).

**Repos touched:** `open-neko/openneko` (engine, UI, worker, migrations) and
`open-neko/plugins` (new `module` capability in the SDK, the
`@open-neko/plugin-salesforce-crm` package, marketplace entry).

---

## 1. Philosophy

### 1.1 Free the data and the CRM follows

Clients don't stay on Salesforce because they like it; they stay because their
operational memory — accounts, contacts, deals, a decade of custom objects — is
held hostage inside it. OpenNeko's founding premise is that *the intelligence is
rented; the memory is yours*. This work extends that premise one step: the system
of record itself moves onto the client's infrastructure, in their own Postgres,
behind their own agent. Migration is not a feature of the CRM; the CRM is the
consequence of the migration.

### 1.2 Metadata over schema

No two Salesforce orgs have the same shape. Custom objects (`__c`), custom fields,
picklists, and relationships differ per client, so **nothing in the engine may
hardcode a business schema**. Every screen, validator, permission check, and agent
affordance is generated from a metadata registry that the import populates. This is
also what makes the engine domain-neutral: "CRM" is not code, it is the first set of
registry rows.

### 1.3 Engine + domain packs, extracted not predicted

The roadmap (CRM → marketing → ERP) means the core investment must be a **records
engine** with domain-neutral names (`record_*`, `module_id`), and each domain is a
pack: metadata (imported from Salesforce for CRM; shipped as canonical starter
schemas for marketing/ERP), an agent skill, and domain-specific action adapters.
Discipline rule: the engine only grows features that the *current* module actually
needs. Generic workflow states, posting rules, or campaign machinery do not enter
the engine until a real module demands them. Domain *behavior* (campaign sends, ERP
postings) is never an engine concern — it lands as per-module adapters and jobs.

### 1.4 Chat-first writes, one write path, one audit trail

The primary create/update surface is the chat agent proposing typed actions through
the existing propose → approve → execute → audit action stack. UI forms exist (it
must feel like a proper CRM) but submit through the *same* action path, auto-approved
because a human filled the form. There is exactly one write path, one validation
layer, one change log. Nothing writes to record tables except the record action
executor.

### 1.5 One RBAC enforcement point

Reads — human UI, chat agent, watchers — all flow through GraphJin running
`auth: jwt`, with per-actor short-lived tokens (the existing GJ4 mechanism). Row
policies and role grants are *generated* from the same policy tables that the write
executor checks. Access rules cannot drift between surfaces because they have a
single source of truth and two mechanical projections (GraphJin config, write-path
checks).

### 1.6 Plugins stay narrow; core ships dormant surfaces

The plugin sandbox model (one-shot JSON-RPC, no host DB, no UI, allowlisted egress)
is a security asset and is not weakened. The CRM follows the proven Scalekit
pattern: the heavy machinery ships **dormant in core**, and a thin marketplace
plugin is the *switch* that lights it up — plus the only parts that genuinely fit a
sandbox (Salesforce-facing connectors: discovery, delta sync). Installing
`@open-neko/plugin-salesforce-crm` makes the CRM section appear, exactly like
installing scalekit makes "Sign in with Scalekit" appear.

---

## 2. Decisions

Each decision records what was chosen, why, and what was rejected.

**D1 — First-party core module, not plugin-delivered UI/schema.**
The plugin RPC surface (`packages/types/src/rpc.ts` in the plugins repo) has eleven
JSON-in/JSON-out methods and deliberately no way to deliver components, routes,
SQL, or jobs. Extending it into an app-platform SDK would be months of trust-model
work before the first screen renders and would dilute the sandbox story. *Rejected:*
plugin-hosted UI; a fifth-generation "apps" SDK.

**D2 — New declarative `module` plugin capability as the enable switch.**
A fifth key in `PluginCapabilitiesDeclaration` (`module: { id, sections }`),
mirroring how `auth` toggles the sign-in button. Presence of an installed,
policy-clean plugin declaring `module.id = "crm"` is what un-hides the CRM nav and
allows engine provisioning. Singleton per module id. *Rejected:* env-flag or
settings-toggle enablement (loses the marketplace install story and the
`installSource`/policy audit trail).

**D3 — Domain-neutral engine naming from day one.**
Tables/adapters/routes say `record`/`module`, never `crm`: `record_object`,
`record_field`, `record_create` adapter, `/m/[module]` routes. Cost now: naming
discipline. Cost of retrofitting after marketing ships: migrations across every
installed deployment. *Rejected:* `crm_*` naming with a later rename.

**D4 — One dedicated business-data Postgres, one schema per module.**
A new `records-db` compose service, fully separate from the neko metadata DB.
Inside it: schema `engine` (registry, change log) and one schema per module
(`crm`, later `marketing`, `erp`). Cross-module joins (campaign → contact,
order → account) stay ordinary SQL and GraphJin sees one database. *Rejected:* one
Postgres per module (turns the highest-value queries into federation); tables in the
metadata DB (mixes operating loop with business data, breaks the "take a backup,
take it with you" story for business records).

**D5 — All reads through GraphJin with per-actor JWTs.**
`records-db` is registered as a data source with `auth_mode: 'jwt'`
(migration `0036_data_source_auth_mode.sql`). Chat runs already mint HS256 actor
tokens (`packages/llm/src/graphjin/token.ts`: `sub` = userId, `role` ∈
admin|member|service, 5-min TTL, per-org derived secret). The web UI's `/m/*` pages
mint the same tokens for the signed-in user and query GraphJin — **no second SQL
read path**. Watchers read as `service`. *Rejected:* direct SQL from Next.js API
routes (second enforcement point, guaranteed drift).

**D6 — All writes through core action adapters.**
`record_create` / `record_update` / `record_delete` registered with
`registerActionAdapter` in the worker (the `user_admin` / `data_source_admin`
precedent in `apps/worker/src/plugins/manage-adapters.ts`). Chat proposes → approval
card → execute. UI form submits create pre-approved action requests through the same
executor. Every write validates against the registry, checks RBAC as the acting
user, appends to `engine.record_change_log`, and records into
`workflow_run.source_writes` (migration `0021`) so watcher cycle-checks keep
working. Default modes: create/update `ask`, delete `ask` (operators can rule-in
`auto` for safe classes). *Rejected:* GraphJin mutations from the agent (bypasses
approval cards and payload validation); sandboxed plugin writes (no DB access, by
design).

**D7 — RBAC v1: org roles + per-object grants + ownership row policies.**
`admin`/`member` from SSO groups (existing `app_user.role`), per-object CRUD grants
in `engine.record_permission` (seeded from Salesforce profiles at import), and a
per-object visibility default (`org` | `owner`) mirroring Salesforce org-wide
defaults, enforced as GraphJin row filters (`owner_user_id = $sub OR role = admin`).
**Explicitly deferred:** role hierarchy, sharing rules, territory management — the
complexity clients are fleeing. The import report shows exactly what collapsed.
*Rejected for v1:* faithful SF sharing-model port.

**D8 — Salesforce fidelity rules.**
18-char Salesforce IDs remain primary keys; every relationship survives verbatim as
an ID column. Formula and rollup fields are **materialized as values** (the formulas
die with Salesforce; the data survives) and marked read-only in the registry.
Compound fields (Address, Geolocation) flatten to columns. Legacy audit columns
(`CreatedById`, `CreatedDate`, `LastModifiedById`, `LastModifiedDate`,
`SystemModstamp`) are preserved read-only; new local audit columns
(`nk_created_*`, `nk_updated_*`) track post-migration writes. Binary content
(`ContentVersion` bodies) is out of v1 scope; the rows import, the blobs defer.

**D9 — User mapping by email, lazy, conflict-explicit.**
`crm.user` (from SF `User.csv`) maps to `app_user` on `lower(email)`, mirroring the
channel-identity pattern (`apps/worker/src/channels/identity.ts`): auto-link
matches, record non-matches as unlinked (they link lazily when that person first
signs in via SSO — same email key the auth plugin guarantees), and surface a
mapping report. Note the host's SSO upsert keys on `sub` first and **fails closed**
on an email bound to a different `sub` (`apps/web/src/lib/auth.ts`,
`upsertUserFromIdentity`), so the report flags email collisions rather than
assuming clean matches. Ownership columns carry both `sf_owner_id` (immutable) and
`owner_user_id` (mapped, nullable until linked).

**D10 — Import runs in the worker, not the sandbox.**
CSV loading needs direct `records-db` access and hours of COPY throughput — host
work. The plugin's role in import is to *trigger and monitor* it (action kinds →
core adapters → a pg-boss job), not to move bytes. Salesforce-*API*-facing work
(discovery against a live org, delta sync during the transition window) does run in
the plugin sandbox, using the detached-job-plus-checkpoint-files pattern forced by
the one-shot 30s RPC (`DEFAULT_RPC_TIMEOUT_MS` in
`apps/worker/src/plugins/openshell-runtime.ts`); the sandbox VM persists across
calls and its bind-mounted work root holds job state.

**D11 — Org scoping everywhere.**
All engine and module tables carry `org_id` matching core conventions, even though
deployments today are effectively single-org. Cheap now, painful to add later; the
GraphJin JWT already carries `org_id` claims for filter generation.

**D12 — Open (product, not architecture):** OSS-core vs paid-module packaging for
the engine; affects nothing below except final package placement, so it does not
block Phase 1. Default assumption in this plan: engine in Apache-2.0 core, plugin in
the official marketplace.

---

## 3. Components

| # | Component | Repo / location | Phase |
|---|-----------|-----------------|-------|
| C1 | `records-db` service & provisioning | openneko: `compose.yml`, `db/records/` | 1 |
| C2 | Engine metadata registry | openneko: `db/records/migrations/`, `packages/records/` | 1 |
| C3 | Importer (CSV + describe → tables + registry) | openneko: `packages/records/src/import/`, worker job | 1 |
| C4 | Identity mapping (SF user ↔ `app_user`) | openneko: `packages/records/src/identity/` | 1 |
| C5 | GraphJin integration (source, roles, tokens) | openneko: `packages/llm/src/graphjin/`, `packages/records/src/policy/` | 1 |
| C6 | Write path (`record_*` adapters, validation, change log) | openneko: `apps/worker/src/records/` | 2 |
| C7 | Web UI module (`/m/[module]`) | openneko: `apps/web/src/app/m/` | 1 (read) / 3 (write) |
| C8 | RBAC policy module (shared read/write source of truth) | openneko: `packages/records/src/policy/` | 1–2 |
| C9 | Agent skills (`records` engine skill + `crm` pack skill) | openneko: `packages/llm/assets/builtin-skills/`; plugins: `packages/salesforce-crm/skill/` | 2 |
| C10 | `module` plugin capability | plugins: `packages/types/`; openneko: worker registry + web gating | 1 |
| C11 | `@open-neko/plugin-salesforce-crm` | plugins: `packages/salesforce-crm/` | 1 (switch) / 4 (sync) |
| C12 | Watcher/briefing seeds for CRM | openneko: seeds + docs | 2 |
| C13 | Backup, disk & ops resilience (see §6) | openneko: compose sidecar, worker jobs, CLI | 1 (backup) / 2 (verify + watchers) |

Dependency spine: C1 → C2 → {C3, C5, C10} → C7(read) → C6/C8 → C7(write) → C11(sync).
C13 depends only on C1 and lands with it — business-critical data is never live
without a backup path.

---

## 4. Component implementation plans

### C1 — `records-db` service & provisioning

**What:** A dedicated Postgres container for business data, plus lifecycle plumbing.

- `compose.yml`: add `records-db` (postgres:16, own named volume, healthcheck,
  password provisioned like `neko-db`'s and rotated via `/setup`). Not started in
  `--mode demo` unless the CRM module is enabled — lazy provisioning keeps the
  default stack unchanged.
- `db/records/migrations/`: engine-schema migrations, numbered from `0001`,
  **separate stream** from `db/migrations/` (different database, different
  lifecycle). Applied by the worker on module enablement and on boot when the
  module is active (same runner pattern as the metadata migrations; add
  `packages/db/src/records-migrate.ts`).
- Metadata-DB migration `0051_module_state.sql` (next free number after `0050`):

  ```sql
  CREATE TABLE module_state (
    org_id      text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    module_id   text NOT NULL,              -- 'crm'
    plugin_name text NOT NULL,              -- '@open-neko/plugin-salesforce-crm'
    status      text NOT NULL DEFAULT 'provisioning',
      -- provisioning | importing | active | disabled
    enabled_at  timestamptz NOT NULL DEFAULT now(),
    config      jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (org_id, module_id)
  );
  ```
- `openneko` CLI: `openneko records status` (connectivity, migration level, module
  states) folded into `openneko doctor`.

**Testing:** migration integration test in the existing style
(`packages/db/test/integration/migrations.test.ts`); compose smoke via
`pnpm dev:setup`.

### C2 — Engine metadata registry

**What:** The tables that make everything else generated, in `records-db` schema
`engine`, plus a typed accessor package.

Registry DDL (abridged; all tables carry `org_id`):

```sql
CREATE TABLE engine.record_module (
  module_id text NOT NULL, org_id text NOT NULL,
  label text NOT NULL, nav_order int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, module_id)
);

CREATE TABLE engine.record_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL, module_id text NOT NULL,
  api_name text NOT NULL,          -- 'account', 'my_object__c' (sanitized)
  sf_api_name text,                -- 'Account', 'My_Object__c' (verbatim)
  label text NOT NULL, plural_label text NOT NULL,
  table_schema text NOT NULL,      -- 'crm'
  table_name text NOT NULL,
  name_field text NOT NULL DEFAULT 'name',
  visibility text NOT NULL DEFAULT 'org',   -- 'org' | 'owner'  (D7)
  is_custom boolean NOT NULL DEFAULT false,
  record_count bigint,             -- refreshed post-import, for nav/report
  UNIQUE (org_id, module_id, api_name)
);

CREATE TABLE engine.record_field (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  api_name text NOT NULL, sf_api_name text,
  label text NOT NULL,
  kind text NOT NULL,
    -- id|text|textarea|boolean|integer|decimal|currency|percent|date|datetime|
    -- email|phone|url|picklist|multipicklist|reference|readonly_formula
  column_name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  read_only boolean NOT NULL DEFAULT false,   -- formulas, legacy audit (D8)
  picklist_values jsonb,                       -- [{value,label,active}]
  reference_object text,                       -- api_name of target (for kind=reference)
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

CREATE TABLE engine.record_layout (        -- detail/form sections; import-generated,
  object_id uuid NOT NULL REFERENCES engine.record_object(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  kind text NOT NULL DEFAULT 'detail',     -- 'detail' | 'list'
  definition jsonb NOT NULL,               -- sections/columns of field api_names
  PRIMARY KEY (object_id, kind)
);

CREATE TABLE engine.record_permission (    -- D7; seeded from SF profiles
  org_id text NOT NULL, module_id text NOT NULL,
  role text NOT NULL,                      -- 'admin' | 'member' (extensible)
  object_api_name text NOT NULL,
  can_read boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  can_update boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, module_id, role, object_api_name)
);

CREATE TABLE engine.record_change_log (    -- D6; the post-migration audit trail
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id text NOT NULL, module_id text NOT NULL,
  object_api_name text NOT NULL, record_id text NOT NULL,
  action text NOT NULL,                    -- create|update|delete|import
  actor_user_id text,                      -- null = service/import
  action_request_id text,                  -- FK-by-value into metadata DB
  changes jsonb NOT NULL,                  -- {field: {from, to}}
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON engine.record_change_log (org_id, object_api_name, record_id, at DESC);

CREATE TABLE engine.identity_map (         -- C4
  org_id text NOT NULL,
  sf_user_id char(18) NOT NULL,
  sf_email text NOT NULL, sf_name text, sf_is_active boolean,
  app_user_id text,                        -- null until linked
  status text NOT NULL DEFAULT 'unlinked', -- linked|unlinked|conflict|ignored
  linked_at timestamptz,
  PRIMARY KEY (org_id, sf_user_id)
);
```

**Accessor package:** new `packages/records/` workspace package —
`registry.ts` (typed loads + an in-process cache keyed on a registry version row),
`naming.ts` (SF → sanitized identifier rules: lowercase, `__c` preserved, reserved
words suffixed, 63-byte truncation with hash disambiguation), `types.ts`. The web
app, worker, and importer all consume this package; nobody re-implements
registry access.

**Testing:** unit tests for naming edge cases (needs to be exhaustive — this is
permanent API surface); registry round-trip integration test against a disposable
Postgres.

### C3 — Importer

**What:** `csv-export/ → live module`. Runs as a worker pg-boss job
(new `QUEUE.RECORDS_IMPORT` in `packages/db/src/jobs.ts`), triggered by an action
adapter (`records_import_start`) so chat can drive it with an approval card, and by
CLI (`openneko records import --module crm --dir ./sf-export`).

Pipeline stages (each checkpointed in `module_state.config.import` so a restart
resumes; progress surfaced via `records_import_status` and a briefing card):

1. **Manifest.** Read `describe/*.json` when present (exact types, picklists,
   relationships, profiles); else infer per CSV: header names + typed sampling
   (10k rows) with the SF type-mapping table below. Emit an **import plan**
   (objects, fields, row counts, inferred vs described, collapsed features) that
   the approval card shows *before* anything is written.
2. **DDL.** Generate `crm.*` tables from the plan. SF → PG mapping:
   `id/reference → char(18)`, `string/textarea/email/phone/url/picklist → text`,
   `multipicklist → text[]`, `boolean → boolean`, `int → integer`,
   `double/currency/percent → numeric`, `date → date`, `datetime → timestamptz`,
   `address/location → flattened columns`, `base64 → skipped (D8)`.
   Formula/rollup → materialized column of result type, `read_only` in registry.
   Add `owner_user_id text` beside `ownerid` where the object has ownership.
   PK on `id`; indexes on every reference column, `SystemModstamp`, and the
   name field. **No FK constraints** — legacy data has dangling references;
   integrity is reported, not enforced.
3. **Load.** Stream each CSV through `COPY ... FROM STDIN` in batches; RFC-4180
   parsing with embedded newlines; empty-string → NULL except for genuinely empty
   text; SF datetime/boolean literal handling; per-file row-count reconciliation
   against the manifest. Failures quarantine the offending rows to
   `engine.import_reject` with reasons rather than aborting the object.
4. **Registry.** Populate C2 tables: objects, fields, relationships (from
   describe `referenceTo` or inferred by 18-char-ID column naming), default
   layouts (detail: sections of ≤2-column field groups in describe order; list:
   name + 5 highest-cardinality-of-use columns), permissions seeded from profiles
   (collapsed to admin/member per D7, mapping report notes what collapsed).
5. **Identity.** Run C4 mapping from `crm.user`.
6. **Validate & report.** Row counts per object vs CSV line counts, sampled
   checksums, dangling-reference counts, unmatched users, permission collapse
   summary → persisted as an import report (briefing finding + `/m/crm/admin`
   page). Set `module_state.status = 'active'`, refresh `record_object.record_count`.

**Testing:** golden-fixture test with a miniature fake SF export (a dozen objects
incl. one `__c`, compound address, formula field, multipicklist, dangling refs,
a user CSV with one email collision); property tests for the CSV parser; resume
test (kill between stages, re-run, assert idempotence — every stage is
`ON CONFLICT`-safe / `IF NOT EXISTS`-guarded).

### C4 — Identity mapping

**What:** `engine.identity_map` population + lazy linking + admin surface.

- **At import:** for each `crm.user` row, `lower(email)` match against
  `app_user` (active only) → `status='linked'`; no match → `'unlinked'`; email
  present on an `app_user` with a conflicting existing link → `'conflict'`.
  Then backfill `owner_user_id` on every owned table via one UPDATE join per
  object.
- **Lazy linking:** hook the SSO upsert (`upsertUserFromIdentity` in
  `apps/web/src/lib/auth.ts`) — after a user row is created/attached, attempt
  `identity_map` linking for that email and backfill `owner_user_id` for newly
  linked SF users (worker job, not in the login request path).
- **Admin surface:** `/m/[module]/admin/identity` — list by status, manual
  link/ignore, re-run backfill. Mirrors the channel-identities settings page
  pattern.
- **Agent access:** the mapping is readable through GraphJin (admin-role only)
  so chat can answer "who owned these accounts in Salesforce?" during transition.

**Testing:** unit tests for match/conflict states; integration test that a fresh
SSO sign-in links a previously unlinked SF user and backfills ownership.

### C5 — GraphJin integration

**What:** Register `records-db` as a jwt-mode data source and generate role config
from the policy tables.

- **Registration:** on module activation, drive the existing
  `register_source` machinery (`packages/llm/src/work/tools.ts`,
  `persistGraphjinSourceConfigUpdate` under `acquireGraphjinConfigLock`) with a
  `database` source named `records`, connection secret via `data_source_secret`,
  `auth_mode: 'jwt'`, signing secret from `graphjinSigningSecretB64(orgId)`
  (`packages/llm/src/graphjin/token.ts`). Approval-gated like every source change.
- **Role generation (C8 output):** a new `packages/records/src/policy/graphjin.ts`
  projects `record_permission` + `record_object.visibility` into GraphJin config:
  role match on the JWT `role` claim; per-table allow/deny from CRUD grants
  (reads only — writes stay `blocked` in GraphJin per D6); row filter
  `{ owner_user_id: { eq: $sub } }` on `visibility='owner'` tables for the
  `member` role; `service` role read-everything (watchers). Regenerated (and
  approval-gated as a config change) whenever permissions change.
- **Web tokens:** small helper for `/m/*` API routes minting
  `mintGraphjinToken({orgId, userId, role})` from the session — same claims shape
  the agent path uses, `GRAPHJIN_TOKEN_TTL_SECONDS` refresh handling included.
- **Blocklist:** `engine.identity_map.sf_email` etc. are fine; ensure nothing in
  records-db matches the global blocklist terms (no secrets stored there, by
  construction).

**Testing:** config-generation snapshot tests (permission fixtures → YAML);
integration test with a live GraphJin container asserting member-vs-admin row
visibility on an `owner`-visibility table.

### C6 — Write path

**What:** Three core action adapters in a new `apps/worker/src/records/adapters.ts`,
registered alongside the manage-adapters at worker boot.

Payload shapes (declared with `example` payloads so the agent emits them correctly
on the first try):

```jsonc
// record_create                          // record_update
{ "module": "crm",                        { "module": "crm",
  "object": "contact",                      "object": "opportunity",
  "fields": {                               "id": "0065g00000ABCDEAA4",
    "lastname": "Rivera",                   "fields": { "stagename": "Negotiation",
    "accountid": "0015g00000XYZ" } }          "closedate": "2026-08-15" },
                                            "expected": { "stagename": "Proposal" } }
// record_delete
{ "module": "crm", "object": "contact", "id": "0035g00000QRSTU" }
```

Executor steps, in order, all inside one transaction against `records-db`:

1. Resolve registry entry (object + fields); unknown object/field → typed error.
2. **Validate** from `record_field`: kinds, required (create only), picklist
   membership, length/scale, `read_only` rejection (formulas, legacy audit,
   `id`), reference-target existence check (warn-not-block for legacy dangles,
   block for new dangles).
3. **RBAC** (C8): acting user's role + `record_permission` CRUD grant +
   ownership rule for `visibility='owner'` objects (member may update own
   records; admin any). Actor comes from the action request's actor snapshot —
   the K1 identity the run already carries.
4. **Optimistic concurrency:** `record_update.expected` (optional map of
   field → expected-current-value) guards chat races; mismatch → error the agent
   can re-plan on.
5. Write; stamp `nk_updated_by/at` (`nk_created_*` on create); soft-delete via
   `nk_deleted_at` (recycle-bin semantics; hard delete is admin-only, later).
6. Append `engine.record_change_log` with field-level diff and
   `action_request_id`.
7. Return `PluginActionOutcome`-shaped result `{externalRef: recordId, result:
   {changed fields}}`; the workflow layer records `(table, pk)` into
   `workflow_run.source_writes` for the subscription cycle-check.

Default `action_policy` seeding: create/update/delete → `ask` (per D6), seeded on
module activation the same way plugin `default_mode` seeds policies.

**UI form path:** `/m/*` form submits POST to a records API route that creates the
action request pre-approved (actor = session user, `commandOrOperation` notes
"form submit") and awaits execution — one executor, one log, and rules/policies
still apply (a `deny` policy blocks forms too, which is correct).

**Testing:** extend the `action-flow` integration-test pattern
(`packages/llm/test/integration/action-flow.test.ts`) for the three kinds:
validation failures, RBAC denials, concurrency conflict, change-log/diff
correctness, source_writes recording, soft delete.

### C7 — Web UI module

**What:** `apps/web/src/app/m/[module]/` — a metadata-driven section, hidden unless
`module_state` has an active module (gating identical in spirit to
`getAuthProvider()`-based sign-in rendering).

> **Mockup & detailed UI plan:** [`mockups/crm-main-screen.html`](mockups/crm-main-screen.html)
> shows the list view built from the app's design tokens;
> [`mockups/README.md`](mockups/README.md) maps every mockup region to
> components, routes, data sources, and milestones (M1–M3 aligned with
> Phases 1–3 below).

Routes:

```
/m/[module]                       → module home: object nav (registry), pinned views
/m/[module]/[object]              → list view: server-driven table; filter/sort/
                                    search on registry fields; saved views (later)
/m/[module]/[object]/[id]         → record detail: layout sections; related lists
                                    from record_relationship; change-log timeline;
                                    inline ask-box
/m/[module]/[object]/new          → create form (generated)
/m/[module]/[object]/[id]/edit    → edit form (generated)
/m/[module]/admin                 → import report, identity mapping, permissions
```

- **Reads:** API routes under `/api/m/...` mint the user's GraphJin token (C5) and
  query GraphJin — list queries are generated GraphQL (object, requested columns,
  filter args, cursor pagination); detail queries batch the record + its related
  lists. No direct SQL (D5).
- **Field rendering/edit widgets** keyed on `record_field.kind` — one component
  per kind (text, picklist select, reference lookup-with-typeahead, date,
  checkbox, currency…). Reference lookups search the target object's `name_field`
  via the same read path.
- **The ask-box** (the differentiator): every list and record view embeds a chat
  entry pre-scoped with module/object/record context (route into the existing
  work-thread machinery with a context preamble). "Log yesterday's call, push
  close date two weeks" → agent proposes `record_update` → the approval card
  renders inline in the thread, consistent with `/work`.
- **Nav integration:** module sections injected into the app shell nav from
  `record_module` + `module_state`, after Briefing/Work — CRM appears only when
  active (D2).
- **Change-log timeline** on record detail reads `engine.record_change_log` —
  this is the audit surface that replaces SF field history.

**Testing:** component tests for the field-widget matrix; e2e in the web test
style (`apps/web/test/`) against a seeded mini-registry: nav gating, list
filtering, detail related-lists, form create/update round-trip through the action
path, member-vs-admin visibility.

### C8 — RBAC policy module

**What:** the single source of truth both surfaces consume —
`packages/records/src/policy/`:

- `evaluate.ts`: `canRead/canCreate/canUpdate/canDelete(actor, object, record?)`
  from `record_permission` + `visibility` + ownership — used by C6 (writes) and by
  C7's form/route guards (defense in depth over GraphJin's read enforcement).
- `graphjin.ts`: the C5 role/filter projection. Same inputs, mechanical output.
- Permissions admin UI (C7 `/admin`) edits `record_permission`; saving triggers the
  approval-gated GraphJin config regeneration.

Rule: no other module may read `record_permission` directly.

**Testing:** table-driven unit tests over the permission matrix; a drift test
asserting `evaluate.ts` and the generated GraphJin filters agree on a fixture set
(generate config, run both against the same records, compare visibility).

### C9 — Agent skills

- **Builtin engine skill** `packages/llm/assets/builtin-skills/records/SKILL.md`
  (pattern: the existing `graphjin-config` skill): how to browse the registry
  catalog, query records via the GraphJin MCP surface, and propose `record_*`
  actions — with the hard rule *resolve the record id via query first; never
  guess-and-write*, disambiguation guidance ("three John Smiths — ask"), and the
  `expected`-field concurrency idiom.
- **CRM pack skill** shipped in the plugin (`packages/salesforce-crm/skill/`,
  declared via `package.json → openneko.skill` like Shopify/Slack): Salesforce
  domain knowledge — object semantics (Account/Contact/Opportunity/Lead
  conversions), stage/pipeline conventions, "owner" language mapping to
  `owner_user_id`, and import/report interpretation.

**Testing:** skill lint via the existing skills validation; scenario transcripts in
the worker's agent test harness for propose-flow correctness.

### C10 — `module` plugin capability

**What:** the fifth declarative key (D2), across both repos.

Plugins repo (`packages/types`, minor+bump to 0.8.0):

- `manifest.ts`: `PluginModuleDeclaration = { id, label, sections? }`;
  `capabilities.module` optional key; singleton **per module id** (two plugins may
  not claim `crm`).
- `schema/marketplace.schema.json`: matching `$defs` addition.
- `define-plugin.ts`: structural validation (id nonempty, lowercase slug). No
  handlers — purely declarative, so no new RPC methods and no `runner.ts` change.

openneko host:

- `plugin-registry.ts`: parse/validate the declaration (enforce per-id
  singleton, mirroring the `auth` singleton check); expose active modules in
  `status()`; on manifest refresh, upsert/disable `module_state` rows via a new
  `onModuleChange` hook wired in `apps/worker/src/index.ts` (activation kicks C1
  provisioning + C5 registration as approval-gated steps; uninstall sets
  `status='disabled'` — **data is never dropped by uninstall**, surfaced as
  "module disabled, data retained" in admin).
- Web: nav gating reads `module_state` (C7).

**Testing:** registry unit tests (singleton conflict, activation hook fire,
disable-on-uninstall); schema validation tests in the plugins repo
(`scripts/validate-marketplace.mjs` fixtures).

### C11 — `@open-neko/plugin-salesforce-crm`

**What:** the marketplace package — enable switch + sandbox-appropriate
Salesforce connectors.

- **Manifest:** `capabilities.module = {id:"crm", label:"CRM"}` +
  `capabilities.action` kinds below. `permissions.network`:
  `*.salesforce.com`, `*.force.com`, `*.my.salesforce.com`. `permissions.env`:
  `SALESFORCE_INSTANCE_URL` (required, not secret), `SALESFORCE_CLIENT_ID`
  (required, not secret), `SALESFORCE_CLIENT_SECRET` (required, secret,
  `inject:"egress"`). Env values only required for live-org features — a
  CSV-only migration installs with none (all marked `required:false`, with the
  skill explaining when they're needed).
- **Action kinds:**
  - `salesforce_discover` (`auto`) — live-org describe sweep → object/field/count
    inventory for pre-migration planning (CSV-only users skip this).
  - `salesforce_export_status` (`auto`) — for orgs exporting via API rather than
    CSV handoff (stretch; v1 may defer the API bulk-export path entirely since
    CSVs are the assumed input).
  - `salesforce_sync_delta` (`ask`) — transition-window incremental sync:
    detached in-VM job (D10) querying `SystemModstamp > watermark` (+`queryAll`
    for deletes), writing normalized change CSVs to the VM work root; a paired
    core job applies them through the C6 executor (as `service` actor, logged as
    such) so even sync writes hit one write path. Explicitly framed as
    transition-only, not a permanent two-way bridge.
  - Rate-limit handling implemented in the plugin's Salesforce client
    (429/`Retry-After` backoff) — no precedent exists in other plugins; must be
    built, not assumed.
- Note: the *import trigger* (`records_import_start/status`) is a **core**
  adapter (D10), not a plugin action — the plugin's presence merely makes the
  module (and thus the import surface) available.
- **Marketplace entry** in `marketplace.json` (draft:true until first publish),
  synced via `scripts/sync-marketplace.mjs`.

**Testing:** plugin unit tests in the repo's per-package style; a mocked-SF-server
test for the delta job's checkpoint/resume; marketplace schema validation.

### C12 — Watcher & briefing seeds

**What:** make the payoff visible on day one post-import. Ship (docs + optional
seed workflows, enabled by choice): "opportunities with no activity in 30 days",
"accounts whose owner is an unlinked/departed SF user", "deals closing this month
by owner", each scoped through the `service` GraphJin role. Also: the import
report lands as a briefing finding (C3 stage 6).

**Testing:** seed workflows run green against the golden import fixture.

### C13 — Backup, disk & ops resilience

**What:** the operational floor under C1, detailed in §6. Concretely:

- `compose.yml`: `records-backup` sidecar (pgBackRest) with WAL archiving +
  scheduled base backups for **both** `records-db` and `neko-db`; `records-db`
  gets its own named volume, healthcheck, and `restart: unless-stopped` matching
  the `neko-db` pattern.
- Worker: `QUEUE.RECORDS_BACKUP_VERIFY` (weekly restore-verification job),
  disk-watermark sampler feeding backpressure state, ops watcher seeds.
- CLI: `openneko records backup now|status|restore --to <time>`; `openneko doctor`
  gains disk-headroom, backup-age, and WAL-archive checks.
- C3/C6 integration: importer pre-flight headroom check; write-path and sync
  backpressure at watermarks; executor idempotency via
  `record_change_log.action_request_id` uniqueness.

**Testing:** kill/restart matrix in CI (compose harness): kill `records-db`
mid-write, fill a small test volume to ENOSPC during import, verify resume and
clean recovery; weekly verify job tested against the golden fixture backup.

---

## 5. Phases & acceptance criteria

**Phase 1 — Read-only CRM (C1, C2, C3, C4, C5, C7-read, C10, C11-switch,
C13-backup).**
Install plugin → CRM appears → run import from CSV dir → browse every object
(standard + custom) in list/detail with related lists → chat answers questions
over CRM data as the signed-in user with owner-visibility enforced → watchers can
read as service → import report + identity report visible.
*Acceptance:* golden fixture import completes resumably; member vs admin see
different rows on an owner-visibility object in both UI and chat; zero writes
possible; WAL archiving + base backup running against both databases and a
manual restore drill documented and executed once — **no import against real
client data before the backup path works**.

**Phase 2 — Chat CRUD (C6, C8, C9, C12, C13-verify/watchers).**
Agent proposes `record_*` actions from natural language; approval cards render;
executed writes appear in record change-log timeline and don't re-fire watchers.
*Acceptance:* action-flow integration suite green incl. RBAC denials and
concurrency conflicts; policy drift test green; replayed action requests are
no-ops (idempotency); weekly restore-verification job green and its failure
alerts through a channel; disk-watermark backpressure demonstrated in the CI
kill/ENOSPC matrix.

**Phase 3 — Full CRM ergonomics (C7-write + admin).**
Generated create/edit forms on every object through the same action path;
permissions admin; identity mapping admin; saved list views.
*Acceptance:* e2e create/edit/delete round-trips per field kind; `deny` policy
blocks the form path too.

**Phase 4 — Transition tooling (C11-sync).**
Delta sync from a still-live org until cutover.
*Acceptance:* mocked-SF delta run applies changes through the C6 executor,
survives kill/resume, records `service` actor in the change log.

**Follow-on (out of this plan's scope, enabled by it):** marketing pack (starter
schema + send-actions reusing existing Gmail/Slack/Telegram plugins), ERP pack
(records + posting adapters), files/ContentVersion import, saved-view sharing,
role model extensions beyond admin/member.

---

## 6. Resilience & operations

> **Platform note:** the posture below has been generalized to everything
> OpenNeko ships — see [RESILIENCE.md](RESILIENCE.md) for the platform
> baseline (whole-deployment backup unit incl. the config/secrets volumes,
> watermark backpressure, ops watcher pack, HA ladder). The records engine
> **inherits** that baseline; this section retains the module-specific
> application: importer pre-flight estimates, write-path idempotency keys,
> records-db watermark behavior, and the CRM restore/identity specifics.
> Where the two documents overlap, RESILIENCE.md is authoritative.

The engine holds business-critical daily-operations data on self-hosted,
often single-host infrastructure. The posture: **crash safety is Postgres's
job; our job is restart orchestration, idempotency, backups that are proven
restorable, disk headroom management, and honest degradation** — with an HA
ladder for clients who need more than a single host, and OpenNeko's own
watcher machinery monitoring the substrate it runs on.

### 6.1 Failure domains at a glance

| Failure | Effect without mitigation | Mitigation (component) |
|---|---|---|
| Container crash (web/worker/graphjin) | Requests fail until restart | Stateless services + `restart: unless-stopped` + healthchecks (exists); pg-boss jobs resume; no state lost |
| Container crash (`records-db`) | Reads/writes fail; no data loss | Postgres WAL crash recovery; healthcheck-gated dependents; fast restart (C13) |
| Worker dies mid-write | Half-applied action? | Single transactional write path (C6); action journal + retry (§6.3) |
| Worker dies mid-import / mid-sync | Stuck migration | Checkpointed idempotent stages (C3); detached VM job + watermark files (C11) |
| Disk full | Postgres PANICs; stack down | Dedicated volume, watermarks + backpressure, pre-flight checks (§6.4) |
| Volume/host loss | **Data loss** | Continuous WAL archiving + base backups + verified restore (§6.5) |
| Silent backup rot | Discovered at the worst moment | Weekly automated restore verification + backup-age watcher (§6.5) |
| GraphJin down | CRM reads fail | Stateless restart; degraded UI banner; agent reports source unavailable (§6.6) |
| Human error (bad bulk update) | Corrupted operational data | Approval cards, change log, soft delete, PITR via WAL (§6.5, C6) |

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

- Every write exists first as an `action_request` row **in the metadata DB** —
  a durable journal independent of `records-db`. If `records-db` is down, the
  approval card and intent survive; execution fails fast with a typed error and
  is retried by pg-boss (`retryLimit`/`retryDelay`/`retryBackoff`, per-queue —
  the `CHANNEL_DELIVER` precedent uses 8 retries with exponential backoff).
- Retries must not double-apply: `engine.record_change_log` gains a **unique
  index on `action_request_id`**, and the C6 executor checks it inside the
  write transaction — a replayed action becomes a no-op with the original
  result returned. (This lands in C6's implementation, not as an afterthought.)
- Delta-sync applies through the same executor, so a crashed sync run resumes
  from its watermark and re-applies safely.

### 6.4 Disk exhaustion — the #1 self-hosted killer

Postgres on ENOSPC PANICs but does not corrupt: freeing space and restarting
recovers. The plan's job is to make that event rare and non-catastrophic:

- **Dedicated volume** for `records-db` (C1), so a runaway container log or
  model cache elsewhere cannot starve the database, and so disk accounting is
  attributable.
- **Pre-flight checks:** the importer estimates footprint (~CSV bytes × 2 for
  heap + indexes + WAL) and refuses to start below that headroom, telling the
  admin exactly how much is needed (C3 stage 1).
- **Watermarks with backpressure** (C13): a worker sampler tracks volume usage.
  At 80% — warning finding on the Briefing + channel alert. At 90% — degrade
  deliberately: pause delta sync and new imports, refuse new bulk operations,
  keep interactive single-record writes alive (they're small and
  business-critical) until a hard stop at 95%. Recovery is automatic when
  space frees.
- **Hygiene:** `temp_file_limit` set, WAL retention bounded by the archiver
  (§6.5), autovacuum/bloat surfaced in `openneko doctor` and `records status`.

### 6.5 Backups — the redundancy floor (non-negotiable, Phase 1)

A single-host deployment's real redundancy is a **verified, off-volume
backup**:

- **Mechanism:** pgBackRest sidecar — continuous WAL archiving plus scheduled
  (default nightly) base backups, covering **both** `records-db` and `neko-db`
  (the action journal and module state live in the metadata DB; a restore
  needs a consistent pair, and cross-DB references are by-value for exactly
  this reason). RPO with WAL archiving: minutes. Point-in-time recovery also
  covers the human-error case ("restore to just before the bad bulk update").
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
- **Import safety:** source CSVs are retained until stage-6 validation passes,
  and the import report reminds the admin to keep the Salesforce export until
  the first *verified* backup exists.

### 6.6 Degradation & self-monitoring

- **Honest degradation:** when GraphJin or `records-db` is unreachable, `/m/*`
  renders an explicit degraded banner (no stale-cache pretending), the agent
  surfaces "records source unavailable" rather than hallucinating around it,
  and queued writes state that they are queued. Approvals never disappear —
  they live in the metadata DB.
- **OpenNeko watches itself** (C13 + C12): the same watcher machinery clients
  use on their business data ships an ops pack for the substrate — disk
  headroom, backup age and last verification result, WAL-archive failures,
  container restart counts, replication lag (when §6.7 Tier 1 is in play),
  import/sync job health. Findings land on the Briefing; alerts go out through
  whatever channels are installed (Slack/Telegram). The CRM monitoring its own
  database is the dogfooding story, and it removes the "nobody was watching
  the self-hosted box" failure mode.

### 6.7 The HA ladder

Redundancy beyond one host is a deployment tier, not an engine feature — the
engine only ever sees a Postgres connection string:

- **Tier 0 (default, single host):** restart policies + crash-safe Postgres +
  continuous verified backups. RPO minutes, RTO tens of minutes (restore
  runbook). Right answer for most small/mid deployments.
- **Tier 1 (warm standby):** streaming replication to a second host (async),
  lag watched by the ops pack, documented manual-promote runbook. RPO seconds,
  RTO minutes. Deliberately manual promotion — automated failover
  (Patroni-class) is out of scope for a compose-based stack and easy to get
  dangerously wrong.
- **Tier 2 (BYO / managed Postgres):** point `records-db` at RDS / Cloud SQL /
  the client's DBA-run HA cluster via `module_state.config.records_db_url` +
  a stored connection secret. The compose service is the default, not a
  requirement; clients with real HA requirements bring infrastructure that
  does HA for a living. Costs the engine nothing beyond honoring an external
  connection string and skipping the sidecar for that database.

### 6.8 Data-lifecycle guards

Already decided, restated as the safety net they form: plugin uninstall
disables the module but **never drops data** (C10); deletes are soft
(recycle-bin semantics, C6); hard-destructive operations (module drop,
restore-overwrite, hard delete) require typed confirmation *and* a
fresh-backup check; every write is attributable in the change log with its
approving action request.

---

## 7. Risks & open questions

- **GraphJin role expressiveness.** Row filters + per-role table grants cover the
  D7 model; if a future module needs per-object *roles* (not just per-object
  grants for two roles), the generated-config approach scales but the JWT `role`
  claim enum (`admin|member|service`) becomes the bottleneck — widening it touches
  `token.ts` and every match expression. Decide when a real need appears (D3
  discipline).
- **Dynamic-DDL hygiene.** The importer generates identifiers from untrusted CSV
  headers; `naming.ts` must be the only path to an identifier and is
  security-sensitive (SQL injection via column name). Mitigation: strict
  allowlist grammar + exhaustive tests + identifiers always quoted.
- **Very large orgs.** COPY throughput is fine, but GraphJin schema discovery over
  hundreds of tables and the UI nav both need the registry's `record_count`/
  usage ordering to stay usable. Watch item, not a blocker.
- **Import UX for describe-less exports.** Type inference will misjudge some
  columns (e.g. all-empty fields). The import plan approval card is the mitigation
  — the admin sees and can adjust inferred types before DDL (plan-edit is a
  Phase 1 stretch; minimum is visibility).
- **Email collisions & shared mailboxes.** `identity_map.status='conflict'` rows
  need a human; the report must make this loud, since silent mis-ownership is the
  worst failure mode of the whole migration.
- **Packaging (D12).** OSS vs paid module — decide before Phase 1 merge only if it
  moves code out of Apache-2.0 core; otherwise defer.
