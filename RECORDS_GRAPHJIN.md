# GraphJin Capability Reference — for the Records Engine

Grounded audit of what GraphJin actually provides for
[RECORDS_ENGINE.md](RECORDS_ENGINE.md), from source: upstream `dosco/graphjin`
master (`47f06ea`) cross-checked against the release OpenNeko pins
(`GRAPHJIN_VERSION=3.18.42` in the Dockerfile). File references below are into
the GraphJin tree. Where this document and RECORDS_ENGINE.md disagree, this
document is the ground truth and the plan needs updating, not the other way
around.

---

## 1. Schema DDL — what exists and how to call it

### The facility

- **GraphJin DDL format**: GraphQL-style desired-state schema docs
  (`type products { id: BigInt! @id  name: Text! }`), canonical file `db.ddl`
  (legacy `db.graphql`), per-source `schema-ddl/<source>.ddl`
  (`core/schema.go:20-42`). Either single-file or per-source layout — both at
  once is a startup error.
- **Diff engine** (`core/schema_diff.go`): introspects the live DB, diffs
  against the DDL doc, emits ordered operations (FK-aware topological table
  ordering). `SupportsSchemaDDL` covers postgres, mysql, mariadb, sqlite,
  mssql, oracle, snowflake.

### Invocation paths at the pinned version — critical

The MCP tools `preview_schema_changes` / `apply_schema_changes` and the
control-plane mutation root are **dead code**: registration is an inert
compatibility hook (`serv/mcp_ddl.go:14-16`), the control-plane dispatcher
never routes to them, and tests assert the mutation root's removal. The
`mcp.allow_schema_updates` flag currently gates nothing functional.

**Live paths:**

| Path | Behavior |
|---|---|
| `graphjin db diff` | prints the SQL delta (or JSON), never executes |
| `graphjin db sync` | preview + destructive warning + interactive `yes` (or `--yes`); applies in **one transaction with rollback-on-error** |
| `graphjin db generate` | introspects live DB → writes DDL file |
| Go: `core.SchemaDiff` / `GenerateDiffSQL` | the same engine as a library |

**C3 consequence:** the schema executor shells out to the shipped `graphjin`
binary — `db diff` output becomes the hashed technical execution artifact and
`db sync --yes` applies. The user-facing approval card renders the high-level
objects, fields, relationships, warnings, and effects; it never exposes SQL.
One version-pinned wrapper module; re-evaluate on every GraphJin bump (the
invocation surface has moved repeatedly).

`db sync` performs a fresh diff; it does not apply an immutable preview
artifact. Therefore proposal stores the DDL, live-catalog revision, preview SQL,
and their hash. Execution re-runs `db diff` and requires an exact match before
calling `db sync --yes`; only C3 has DDL credentials, and its schema lease spans
the final diff, sync, and post-apply verification. Any drift invalidates the approval. The apply is one
database transaction, but registry/config/metadata projection around it is a
durable saga, not a distributed transaction.

### DDL format cheat sheet

Types (Pascal-cased; normalized by de-camel-casing): `BigInt`, `Int`,
`SmallInt`, `Float`, `Double`, `Numeric` (+ `@type(args: "10, 2")` for
precision), `Boolean`, `Text`, `Varchar`, `Char` (+ `@type(args: "18")`),
`Timestamptz`, `Timestamp`, `Date`, `Time`, `Interval`, `Json`, `Jsonb`,
`Uuid`, `Bytea`, `Inet`, `Money`, `Serial`, `BigSerial`, geo types.
Field directives: `@id`, `@unique`, `@index` (+ `name:`), `@search`
(tsvector GIN), `@default(value:)`, `@type(args:)`,
`@relation(type:, field:, onDelete?:, onUpdate?:)`, `@blocked`.
Type directives: `@schema(name:)`, `@database(name:)`, `@function`,
`@cluster`. Not-null via trailing `!`.

### Hard limits the engine must design around

1. **Diff is strictly additive — and that is an integrity feature.**
   `create_table`, `add_column`, and index/FK **on newly added columns
   only**. It never generates type changes, `SET/DROP NOT NULL`, default
   changes, index-on-existing-column, or constraint drops — those diffs are
   silently ignored (`core/schema_diff.go:245-455`). This mechanically
   enforces the plan's own D7 rule (agent-authored schema evolution is
   additive; data is never destroyed or reshaped in place): type changes
   become add-new-field + backfill + archive-old — every step additive,
   every step through GraphJin. Adding an index to an *existing* column is
   the one genuinely missing operation: declare indexes at field-creation
   time; later addition is a documented limitation and an upstream
   contribution candidate. `destructive: true` gates exactly
   `drop_column`/`drop_table` — and a partial DDL doc + destructive would
   propose dropping every table not listed. **We never pass destructive.**
2. **Postgres arrays don't work**: `[Text]` parses but the Postgres dialect
   never consults the array flag → plain `TEXT`. → `multipicklist` maps to
   **`Jsonb`**, not `text[]` (plan updated).
3. **`@schema` is non-functional for Postgres DDL**: parsed, but every
   `CREATE`/`ALTER`/index statement is emitted unqualified — everything lands
   in the connection's `search_path`, and the differ keys tables on bare name
   (schema collisions merge). → per-app **table-name prefixes** instead of
   per-app Postgres schemas (plan updated; `engine.*` tables are created by
   our own migrations, where schemas work fine, and GraphJin can *query*
   non-default schemas — only DDL generation is search_path-bound).
4. **`@default` values pass through with zero quoting/escaping** — an
   injection point. → the engine **never emits `@default`**; defaults are
   write-path behavior.
5. **`@id` on int types silently becomes `BIGSERIAL PRIMARY KEY`**; a
   non-serial integer PK is inexpressible. `id: Text! @id` → `TEXT PRIMARY
   KEY` (what we use: 18-char source IDs and UUID-as-text). **No composite
   PKs** on Postgres.
6. **`CharacterVarying` / `Character` are buggy** (prefix-matching bug emits
   `CHAR(acter varying)`). Use `Varchar` / `Char`, or just `Text`.
7. **Identifier rules** for `naming.ts`: lowercase snake_case only (mixed
   case gets quoted verbatim and breaks diff matching); names can't start
   with a digit; `on`, `true`, `false` are lexer-reserved in any case; no
   quoting mechanism exists for special characters; auto-generated index/FK
   names (`idx_<table>_<column>`, `fk_<table>_<column>`) have **no 63-byte
   guard** — keep table+column budgets short or pass explicit
   `@index(name:)`.
8. **No `CREATE FUNCTION`, no FK-cycle handling** (cycle → unsorted order →
   failing SQL; our no-FK-constraints convention sidesteps this for data
   relationships).

Policy consequence: **the engine authors no SQL against app tables.** What
GraphJin DDL can't express is designed around (arrays → `Jsonb`; per-app
schemas → table prefixes; defaults → write-path behavior), not worked
around with side-channel SQL. The one engine-owned SQL surface is the
`engine.*` substrate itself (registry migrations and the audit trigger
installed at table provisioning, §3) — substrate, not write path. Trigger
attachment is explicitly versioned, idempotent, and reconciled after DDL; this
bounded second DDL path is part of the trust substrate rather than an
unacknowledged exception.

Also useful from the config surface (`configure/database`): `tables:`
mapping supports **aliases** (`name: account, table: crm__account`,
per-source `schema:` overrides, column metadata/blocklists) — so the D4
table-name prefix never has to appear in GraphQL — and explicit
`relationships:` config covers relations introspection can't infer,
including cross-source joins.

---

## 2. Auth & RBAC — two role-configuration styles

**Roles are first-class in GraphJin.** The documented Table-permissions
model (`website/content/configure/auth-rbac.md`, graphjin.com/configure/
auth-rbac) is exactly our D8 shape: per-role · per-table ·
per-operation config — `query/insert/update/upsert/delete`, each with
`filters` (AND-ed GraphQL-shaped strings, e.g.
`"{ owner_user_id: { eq: $user_id } }"`), `columns` allowlists, `presets`
(server-injected fields, **YAML map form**, not the list form some docs
show), and `block`. There are two ways role rules come to exist:

- **Explicit role-table config** (`roles[].tables`, hand- or
  machine-written): the full model above. Role resolution via `roles_query`
  + per-role `match` expressions (SQL or GraphQL dialect; needs >2 declared
  roles to activate).
- **Generated source-access rules** (`sources:` present): role tables are
  *derived* from `sources[].access` (read/write/delete ∈
  blocked|public|authenticated|account|owner|admin + `owner_column` /
  `namespace_column` + public/admin/blocked table lists). Coarser by
  design — role differentiation is anon vs authenticated vs `admin_roles`.
  JWT claim→role mapping (`identity.role_claims`) runs only in this mode
  (`serv/identity.go:46-49`).

**The one hard constraint:** the two styles cannot mix in a single config —
user-written `roles[].tables` alongside `sources:` is rejected at startup
(`core/config.go:280-285`, same at the pinned tag), and the auth-rbac docs
say the same ("do not mix user-written roles[].tables rules with
sources:"). This is a config-layout constraint, not a capability gap.

### The records RBAC architecture (what the plan uses)

The C7 policy module generates the **explicit role-table config** for the
records database — the documented Table-permissions model:

- **The projection must be exhaustive and live-catalog driven**: with explicit role tables, a
  non-`anon` role with *no* entry for a table has **unrestricted CRUD on
  it** (`default_block` shields only `anon`). Introspect every physical table,
  then emit every table × every role × all five operations explicitly on every
  regeneration. Archived/orphaned app tables and unexposed `engine.*` tables
  are blocked, never omitted. Registry rows narrow the live catalog; they do
  not define its universe. Correctness *and* security invariant — test it.
- Row filters: `filters: ["{ owner_user_id: { eq: $user_id } }"]` on
  `visibility='owner'` tables for `member`; none for `admin`. `$user_id`
  resolves from the JWT `sub`.
- Role resolution: `roles_query` against a small engine-maintained actor
  table (`engine.actor`: user id → role, synced from `app_user` by the
  worker) + `match: "role = 'admin'"` etc. (`identity.role_claims` is
  source-mode-only, so the claim path doesn't apply here.)
- Mutation gating per role = explicit per-operation config: `admin` and
  `member` get `block: true` on **every mutation**, regardless of registry CRUD
  grants; those grants are interpreted by the C4 action executor. `delete` is
  blocked for every role because deletion is a soft update. `service` is the
  only mutation-capable role, only ever resolved for worker-held credentials,
  and still receives org presets/filters plus deleted-row defaults as defense
  in depth. (Never use
  `read_only: true` on a role table as the blocking mechanism — an explicit
  `insert:` block silently overrides it.)
- Because of the no-mixing constraint, the records config lives apart from
  the customer-data source-mode config in the dedicated `records-graphjin`
  instance (the `neko-graphjin` precedent).

### `read_only` and `analytics_mode` — exact semantics

- `read_only: true` (source/db/table level): blocks **all mutations
  role-independently** and DDL; reads/subscriptions unaffected. Correct and
  kept for customer sources. Not used on records (it would block C3).
- `analytics_mode: true` (global or per-DB `*bool` override): (1) implicit
  row-limit defaults off (`NoLimit`) — explicit query `limit:` and role
  `query.limit` still win; (2) tables with a declared partition key require
  a filter on it (hard error; `unrestricted: true` does **not** bypass a
  declared key), and tables with an implicit temporal column
  (`created_at`, `updated_at`, `event_time`, `timestamp`, `ingested_at`)
  require a filter or `unrestricted: true`. **Records tables mostly carry
  legacy `createddate`/`systemmodstamp` and local `nk_created_at` columns —
  `nk_created_at`-style names are not in the implicit list, but `created_at`
  naming would be.** Watch for accidental temporal-filter requirements on
  UI list queries; declare `partition.none: true` per table if it bites.
- Config-update surface: `identity`, `auth`, global `analytics_mode`, and
  `default_limit` are **file-only** — not writable via `gj_config`. MCP
  config tools exist in dev mode only, and disk persistence of runtime
  config changes is dev-only. → C5/C7 regenerate config **as files** under a
  records-specific lock, validate, atomically replace, and reload the dedicated
  `records-graphjin` service. This is a new complete-config writer; it must not
  call the customer-source `persistGraphjinSourceConfigUpdate` helper.

---

## 3. Reads, writes, subscriptions

### Mutations — all record writes go through GraphJin

- Syntax: `table(insert: {...})`, bulk via arrays, nested/connected inserts,
  `update`/`upsert`/`delete` with **required** `where` (or `id:`),
  `on_conflict: get` for idempotent single inserts, `@constraint` validation
  directives, presets for server-injected fields.
- On Postgres a mutation compiles to **one CTE-chain statement** — atomic.
  Multiple roots in one mutation are allowed when every root is the **same
  operation type** (`qcode.go:1583-1591`).
- How the executor's shapes map onto that, with no engine SQL in the write
  path:
  - **Create** — one insert mutation (atomic CTE chain).
  - **Update / soft-delete** — one `update` mutation; soft delete *is* an
    update of `nk_deleted_at`, so `delete` mutations are never used and
    stay `block: true` for every role. **Optimistic concurrency rides the
    `where` clause**: the executor folds `expected` values into the update
    filter (`where: { id: {eq: $id}, stagename: {eq: "Proposal"} }`) — an
    empty result array means the expectation failed. Race-free, in-engine.
  - **Change-log capture** — a generic audit trigger on every app table
    (installed once at table provisioning; part of the `engine.*`
    substrate, like the registry migrations) writes
    `engine.record_change_log` from OLD/NEW **in the same transaction as
    the GraphJin mutation**. Actor and request identity travel on the row
    (`nk_updated_by`, `nk_action_request_id`, set in the same mutation), so
    the trigger has full context. The change log is one-to-many by action
    request and unique only by deterministic per-row `mutation_id`; command
    idempotency lives in `engine.action_execution`. This closes the mixed-op gap
    (an update + a log insert can't
    share one mutation) without any engine-side write SQL — and captures
    every write path uniformly, defense in depth included.
  - **Bulk import** — batched GraphJin array inserts (one atomic statement
    per batch) with a target-side deterministic batch receipt included in the
    same insert operation, quarantine via batch bisection on failure. Throughput vs
    `COPY` is a measured risk, not a design change.

Every generated ordinary read—including service reads—adds
`nk_deleted_at: {is_null: true}` unless the caller explicitly requests the
recycle-bin scope. The same invariant covers counts, reference lookup,
relationships, subscriptions, and watches.

### Query features for the generated UI

- Filter operators: full set incl. `eq/neq/gt/lt/gte/lte/in/nin/is_null`,
  `like/ilike/regex/iregex`, JSON `contains/has_key*`, geo. **Whole-object
  `where: $where` variables are rejected by design** — generated documents
  inline the filter shape and bind only leaf variables (matches our
  injection-resistance rule).
- Aggregates: `count_<col>` / `sum_` / `avg_` / `min_` / `max_` field
  prefixes; group-by via `distinct: [cols]`; expression aggregates; window
  directives (`@rank`, `@running`, …). This is the D15 metric-block query
  vocabulary.
- Pagination: `limit/offset` and encrypted cursors (`first/after` +
  root-level `<table>_cursor` field; cursor must be a variable; requires
  `SecretKey` and stable `order_by`). Limit precedence: explicit query
  limit → role-table limit → analytics `NoLimit` → `default_limit` →
  hardcoded 20. A **variable** limit is clamped server-side to
  `LEAST($n, <role limit|default_limit|20>)` — generated list queries
  should inline literal limits, not variables, to control page size
  exactly.
- Truncation: `Result.RootLimits()` / `TruncatedRoots()` (and MCP
  `truncation` field) report lists that hit their compiled limit — the
  "load more" signal; no total counts are provided (the UI's `total` comes
  from a separate `count_id` aggregate query).

### Watching changes — raw subscriptions vs `gj_watch`

Two layers with very different guarantees:

- **Raw subscriptions** (in-process channel / SSE / WS): polling controller
  (no LISTEN/NOTIFY); `subs_poll_duration` **must be set explicitly** —
  unset means a 200ms floor, not the 5s the schema annotation implies.
  Batched on Postgres (one round-trip per ≤5000 subscribers per poll).
  Delivery is **at-most-once**: the cursor/hash advance *before* delivery,
  and a consumer slower than 250ms with a full buffer permanently loses
  that update. Fine for live UI refresh; not for triggering work.
- **`gj_watch` — the durable layer, and the right one for records watchers
  (C12):** standing cursor-backed subscriptions stored as artifacts,
  evaluated **with the owner's stored identity and role** (never elevates
  access), with **persisted cursor checkpoints** — restart/failover-safe,
  resuming from the stored cursor so nothing is missed — deterministic
  event IDs (`watch_id + data_hash`, replica-safe dedup), a durable
  `gj_watch_event` inbox with seen/snooze semantics, **absence watches**
  ("tell me if no scan arrives for four hours" — silence as a first-class
  event), digest coalescing, rollup watches for cross-watch correlation,
  and webhook/workflow delivery gated by **exact-hash approval** (create ≠
  approve, by design — the same propose/approve philosophy as our action
  stack). Webhook targets must match `watches.webhook_allow`; deliveries
  carry HMAC signatures and idempotency keys; failures back off and
  dead-end into an inspectable error state, never silent deletion.
- Transport for raw subscriptions: SSE (`Accept: text/event-stream` on
  `/api/v1/graphql`) or WebSocket; plain POST subscriptions are rejected.
  Watch management: GraphQL roots `gj_watch` / `gj_watch_event`, REST
  wrappers under `/api/v1/watches`, MCP wake resources per watch.

### Allow-list / production mode

In `mode: prod`, query bodies are frozen to named saved queries
(`queries/*.gql`); `Subscribe` is gated the same way. Our UI generates
documents dynamically from the registry, so the records GraphJin
configuration runs with the allow-list disabled (or prod-security opted
out) **for the records source only**, with enforcement carried by the
generated role config + JWT — which is where D5 put it anyway. Customer
sources keep their existing posture. Flag this explicitly in the security
review of C5.

RBAC is necessary but does not bound query cost. The records data-plane
boundary uses GraphJin/Postgres controls where native and the OpenNeko query
builder/reverse proxy where not to enforce statement timeout,
depth/complexity, role query limits, aggregate/card ceilings, bounded regex and
list inputs, and per-actor rate limits. Analytics blocks that need higher
limits declare reviewed budgets; `analytics_mode` is never interpreted as
permission for unbounded work.

---

## 4. Surfaces the worker/web can call

- HTTP: `POST /api/v1/graphql` (JSON | GET | WS | SSE),
  `POST /api/v1/rest/<name>` (saved queries), `/api/v1/mcp/message`
  (JSON-RPC tools — what `graphjin cli` wraps), `/health`.
- CLI: `graphjin db diff|sync|generate|seed|setup` (schema);
  `graphjin cli <tool> --args '{...}'` for every MCP tool
  (`execute_graphql`, `query_catalog`, `graphql_help`,
  `execute_saved_query`, `validate_where_clause`, config tools in dev);
  `graphjin cli query subscribe` (SSE).
- Go embedding (`core.NewGraphJin`) exists but is not our path (TS stack).

### Agentic surfaces worth wiring in

- **`gj_security` (security graph):** queryable effective policy — mode,
  capabilities, read-only state, high/critical findings with
  recommendations — meant to be consulted *before* mutations, config
  changes, or schema actions. The records/app-builder skills adopt this as
  a hard rule: check `gj_security` before proposing write-capable actions.
- **Catalog annotations (`gj_artifacts` kind `annotation`):** durable,
  reviewable org notes addressed to catalog entities (`table:`, `column:`,
  `saved_query:`…), tiered observed (owner-only) → approved
  (account-visible). Treated as data, never instructions. A natural home
  for the business context our apps accumulate ("expedite checks use the
  requested ship date") — the agent can write drafts and an admin approves,
  mirroring our approval culture.
- **Dedicated reloads:** validate and atomically reload the standalone records
  config; records churn never disturbs customer sources because it is a
  separate process. During new-table rollout the records instance is removed
  from readiness until live-catalog policy projection validates, eliminating
  the fail-open exposure window.
- **Hosted MCP OAuth:** if the records MCP surface is ever exposed beyond
  localhost, GraphJin ships protected-resource metadata, PKCE/DCR, and
  audience validation (`mcp.oauth`); note for any future remote-agent
  story, not needed for the in-stack worker.

## 5. Plan deltas this audit produced

Applied to [RECORDS_ENGINE.md](RECORDS_ENGINE.md):

1. **C3 apply mechanism** → `graphjin db diff` (approval-card SQL) +
   `db sync --yes` (transactional apply) via the shipped binary; the MCP /
   control-plane preview-apply surface is removed at the pinned version.
   Additive-only diff embraced as the mechanical enforcement of D7; the
   engine authors **no SQL against app tables** (the `engine.*` substrate —
   registry migrations + audit trigger — is the only engine-owned SQL).
2. **D4 storage layout** → per-app **table-name prefixes** in the records
   source's default schema (GraphJin DDL can't schema-qualify on Postgres),
   hidden from GraphQL via `tables:` aliases; `engine.*` keeps its own
   schema via engine migrations.
3. **Type mapping** → `multipicklist: Jsonb`; `Varchar`/`Char` spellings;
   no `@default` emission; PK stays `Text @id`.
4. **C5/C7 RBAC** → the documented Table-permissions model
   (`roles[].tables`), machine-generated from the live catalog: exhaustive per
   table×role×operation projection (omission grants access), human mutations
   always blocked, service mutations org-scoped,
   `roles_query` + `engine.actor` for role resolution, explicit per-op
   `block: true`; a dedicated `records-graphjin` instance and complete-config
   writer keep records apart from customer source-mode config (the two styles
   can't share one config).
5. **C4 writes go through GraphJin** — creates as insert mutations,
   updates/soft-deletes as conditional `update` mutations (`expected`
   folded into `where` for optimistic concurrency), change-log capture via
   the provisioning-installed audit trigger, imports as batched array
   inserts. `delete` mutations blocked for all roles (deletes are soft).
6. **C12 watchers** → `gj_watch` is the primary records watch mechanism
   (durable cursors, owner-scoped identity, absence watches, exact-hash
   action approval); raw subscriptions serve live-UI freshness only.
7. **C6** → literal limits in generated queries; truncation signals for
   load-more; `count_` aggregate for totals.
8. **naming.ts** → lowercase snake_case, digit-start ban, `on/true/false`
   ban, identifier length budget for auto-generated index/FK names.
9. **Skills** → consult `gj_security` before write-capable proposals;
   catalog annotations as the home for accumulated business context.
10. **Approval/apply integrity** → persist catalog revision + DDL + preview SQL
    hash, re-diff immediately before execution, and require re-approval on
    drift; reconcile the surrounding cross-database saga after failure/restore.
11. **Idempotency and deletion** → command receipts are separate from the
    one-to-many change log; deterministic row/batch ids guard replay; every
    ordinary query/count/reference/watch excludes soft-deleted rows.
12. **Dynamic-query safety** → the disabled allow-list is paired with explicit
    time, depth, complexity, row, aggregate, regex/list, and rate budgets plus
    adversarial load tests.
