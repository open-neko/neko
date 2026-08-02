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
binary — `db diff` output feeds the approval card, `db sync --yes` applies.
One version-pinned wrapper module; re-evaluate on every GraphJin bump (the
invocation surface has moved repeatedly).

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

1. **Diff is strictly additive**: `create_table`, `add_column`, and
   index/FK **on newly added columns only**. It never generates type changes,
   `SET/DROP NOT NULL`, default changes, index-on-existing-column, or
   constraint drops — those diffs are *silently ignored*, not errored
   (`core/schema_diff.go:245-455`). `destructive: true` gates exactly
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

Anything on this list that an app schema needs anyway (arrays,
index-on-existing-column, type migration add+backfill) is the **engine
residue path**: our own SQL, applied in our own transaction, logged in
`app_schema_log` the same way.

---

## 2. Auth & RBAC — the two-mode reality

### Two mutually exclusive config modes

- **Source mode** (`sources:` present): role tables are **generated** from
  `sources[].access`; hand-written `roles[].tables` is **rejected at
  startup** (`core/config.go:2312-2318`). JWT claim→role mapping
  (`identity.role_claims`) works **only** here (`serv/identity.go:46-49`).
- **Legacy mode** (no `sources:`): full hand-written per-role · per-table ·
  per-operation config — `query/insert/update/upsert/delete`, each with
  `filters` (AND-ed GraphQL-shaped strings, e.g.
  `"{ owner_user_id: { eq: $user_id } }"`), `columns` allowlists, `presets`
  (server-injected fields, **YAML map form**, not the list form some docs
  show), and `block`. Role resolution comes from `roles_query` + per-role
  `match` expressions (needs >2 declared roles to activate) — **not** from
  JWT claims, which only carry `sub` here.

### What source-mode access can and cannot express

Per-source `access: { read, write, delete }` ∈
blocked|public|authenticated|account|owner|admin, plus `owner_column`,
`namespace_column`, and three per-table lists (`public_tables`,
`admin_tables`, `blocked_tables`). Role differentiation is **only** anon vs
authenticated vs `admin_roles` membership. **It cannot express our D8 model**
(per-object CRUD grants per role; per-object `org` vs `owner` visibility
within one source).

### Consequence — the records RBAC architecture (plan updated)

The records engine needs the **legacy-mode role model**, generated:

- `records-db` is served by a GraphJin instance whose records configuration
  is legacy-mode; the C7 policy module generates the full `roles:` block.
- **The projection must be exhaustive**: in legacy mode, a non-`anon` role
  with *no* entry for a table has **unrestricted CRUD on it**
  (`default_block` shields only `anon`). Every object × every role × all
  five operations, explicitly, every regeneration. This is a correctness
  *and* security invariant — test it.
- Row filters: `filters: ["{ owner_user_id: { eq: $user_id } }"]` on
  `visibility='owner'` tables for `member`; none for `admin`. `$user_id`
  resolves from the JWT `sub` (the generic JWT provider maps only `sub` →
  user id; OpenNeko's minted tokens already carry it).
- Role resolution: `roles_query` against a small engine-maintained actor
  table (`engine.actor`: user id → role, synced from `app_user` by the
  worker) + `match: "role = 'admin'"` etc. This replaces the source-mode
  role-claim path, which is unavailable in legacy mode.
- Mutation blocking for user roles = explicit `block: true` per operation
  (not `read_only: true` on the role table — an explicit `insert:` block
  **silently overrides** `read_only`). The `service` role's tables carry
  full mutation grants; `service` is only ever resolved for worker-held
  credentials.
- Do not mix modes: the customer-data GraphJin instance keeps its
  source-mode config untouched. Whether records rides a separate instance
  (the `neko-graphjin` precedent) or a legacy-mode config alongside is a C5
  implementation choice; separate instance is the safe default.

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
  config changes is dev-only. → C5/C7 regenerate config **as files** under
  `acquireGraphjinConfigLock` and reload — which is exactly OpenNeko's
  existing `persistGraphjinSourceConfigUpdate` pattern. No new mechanism.

---

## 3. Reads, writes, subscriptions

### Mutations — why C4 stays direct SQL

- Syntax: `table(insert: {...})`, bulk via arrays, nested/connected inserts,
  `update`/`upsert`/`delete` with **required** `where` (or `id:`),
  `on_conflict: get` for idempotent single inserts, `@constraint` validation
  directives, presets for server-injected fields.
- On Postgres a mutation compiles to **one CTE-chain statement** — atomic.
  Multiple roots in one mutation are allowed **only when every root is the
  same operation type** (`qcode.go:1583-1591`).
- Our executor's shape is `update record` + `insert change-log row` (mixed
  types) + registry/app_state touches, atomically. The Go-only `GraphQLTx`
  is unreachable from the TS worker. → **C4 keeps its own Postgres
  transaction with direct SQL.** GraphJin is the read/subscription/DDL
  plane; the one-write-path guarantee lives in the action stack + role
  config (user roles get `block: true` on all mutations), not in routing
  writes through GraphJin.

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

### Subscriptions — at-most-once, plan accordingly

- Polling controller (no LISTEN/NOTIFY). `subs_poll_duration` **must be set
  explicitly** — unset means a 200ms floor, not the 5s the schema
  annotation implies. Batched on Postgres: one round-trip per ≤5000
  subscribers per poll, adaptively chunked.
- Delivery is **at-most-once**: identical-result dedup by hash; the cursor
  and hash advance *before* delivery, and a consumer slower than 250ms with
  a full 10-slot buffer **permanently loses that update**. Intermediate
  states between polls are never observed.
- → Subscription-triggered watchers are a **freshness optimization only**.
  The authoritative mechanisms are the scheduled-watch path and
  cursor-based catch-up reads; `workflow_run.source_writes` cycle-checks
  apply in both modes. GraphJin's `gj_watch` layer (durable events,
  deterministic IDs, webhook retries) is a C12 evaluation candidate for
  trigger delivery.
- Transport: SSE (`Accept: text/event-stream` on `/api/v1/graphql`) or
  WebSocket; plain POST subscriptions are rejected.

### Allow-list / production mode

In `mode: prod`, query bodies are frozen to named saved queries
(`queries/*.gql`); `Subscribe` is gated the same way. Our UI generates
documents dynamically from the registry, so the records GraphJin
configuration runs with the allow-list disabled (or prod-security opted
out) **for the records source only**, with enforcement carried by the
generated role config + JWT — which is where D5 put it anyway. Customer
sources keep their existing posture. Flag this explicitly in the security
review of C5.

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

## 5. Plan deltas this audit produced

Applied to [RECORDS_ENGINE.md](RECORDS_ENGINE.md):

1. **C3 apply mechanism** → `graphjin db diff` (approval-card SQL) +
   `db sync --yes` (transactional apply) via the shipped binary; the MCP /
   control-plane preview-apply surface is removed at the pinned version.
2. **D4 storage layout** → per-app **table-name prefixes** in the records
   source's default schema (GraphJin DDL can't schema-qualify on Postgres);
   `engine.*` keeps its own schema via engine migrations.
3. **Type mapping** → `multipicklist: Jsonb`; `Varchar`/`Char` spellings;
   no `@default` emission; PK stays `Text @id`.
4. **C5/C7 RBAC** → legacy-mode generated roles (exhaustive per
   object×role×operation projection — omission grants access),
   `roles_query` + `engine.actor` for role resolution, explicit per-op
   `block: true`, records config file-generated under the existing lock;
   records kept apart from the customer sources' source-mode config.
5. **C4** → direct SQL transaction reaffirmed; GraphJin-mutation write path
   dropped (mixed-op atomicity unreachable over HTTP).
6. **C5 subscriptions** → at-most-once semantics; scheduled path stays
   authoritative; explicit `subs_poll_duration`; `gj_watch` as C12
   candidate.
7. **C6** → literal limits in generated queries; truncation signals for
   load-more; `count_` aggregate for totals.
8. **naming.ts** → lowercase snake_case, digit-start ban, `on/true/false`
   ban, identifier length budget for auto-generated index/FK names.
