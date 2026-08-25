# OpenNeko Magento solution pack — implementation plan

Status: proposed
Prepared: 2026-08-20
First pack: Magento Open Source / Adobe Commerce 2.4.x
Next consumer: WooCommerce pack
Upstream dependency: the
[GraphJin OpenAPI mutation plan](../../GraphJin/OPENAPI_MUTATIONS_IMPLEMENTATION_PLAN.md)

## 1. Outcome

Ship Magento as the first production-grade OpenNeko solution pack. Installing
the pack gives an organization:

- A least-privilege, read-only Magento MariaDB analytics source.
- A curated Magento REST source for a small set of governed writes.
- Deterministic Magento metrics and metric cards.
- Magento workflows and polling watchers.
- Focused Magento operator skills for performance reviews, individual order
  investigations, fulfillment triage, refund/cancellation analysis, inventory
  checks, and platform-health diagnosis.
- Preflight checks, health checks, upgrade/uninstall behavior, artifact
  provenance, documentation, and regression tests.

The work also creates the reusable pack substrate required by WooCommerce and
later packs. The existing demo-pack installer is not extended into this role;
demo packs remain isolated demonstrations, while solution packs are composable,
versioned product extensions.

### V1 non-goals

- A public third-party pack marketplace or remote registry.
- Executing arbitrary scripts supplied by a pack.
- Importing Magento's entire authenticated REST schema.
- A Magento extension/module for webhooks; V1 watchers poll through GraphJin.
- Conversion analytics without an explicitly connected traffic source.
- Cancel, refund, shipment, customer, payment, or inventory write operations.
- Automatic creation of database or Magento Integration credentials using an
  administrator password.

## 2. Release dependency

The Magento pack contains two independently usable capability groups:

1. **Analytics:** read-only MariaDB, metrics, workflows, watchers, skills.
2. **Operator:** governed Magento REST actions executed through
   GraphJin OpenAPI mutations.

They are not separate install profiles. Installing `magento` always
installs the complete declared artifact set, including action definitions and
policies. Capability readiness is evaluated separately: missing or invalid
write credentials leave the operator capability blocked without making the
installation partial or failed.

The analytics work and pack substrate may be developed against a local GraphJin
canary. The production Magento pack must not make its installed operator action
executable until GraphJin has published a tagged release satisfying the upstream
plan. That release must also contain the table-column blocklist enforcement fix
required by the analytics source. OpenNeko's post-install check verifies that
operational `sales_order.customer_id` and `sales_order.customer_email` are
readable, then deliberately queries the blocked guest-order
`sales_order.protect_code` secret and fails closed unless GraphJin rejects it; a
version number alone is not accepted as security evidence.

Release order:

```text
GraphJin mutation implementation
  -> GraphJin tests and Magento canary
  -> tagged GraphJin minor release + images/assets
  -> OpenNeko GraphJin pin upgrade
  -> OpenNeko compatibility soak
  -> Magento governed-action end-to-end test
  -> Magento pack release
```

OpenNeko must never ship this pack against `dosco/graphjin:latest`, a local
commit image, or a guessed future version.

## 3. Standing product and architecture decisions

1. **Solution packs coexist.** Magento, Stripe, Slack, and other packs may be
   installed together. There is no `primary-demo` exclusivity rule.
2. **OpenNeko owns the runtime; packs own declarations.** Lifecycle, validation,
   policy, secrets, approvals, and audit code lives in OpenNeko. A pack contains
   declarative assets and narrowly scoped tests, not arbitrary install scripts.
3. **First-party packs live in this repository for V1.** Use
   `packs/magento/`; package/repository distribution can be separated after the
   manifest and signing contract stabilizes.
4. **No raw metadata SQL bootstrap.** All pack artifacts are applied through
   typed stores/control-plane services and recorded with provenance.
5. **No arbitrary pack code.** V1 manifests cannot execute shell, JavaScript,
   SQL, or container commands supplied by a pack.
6. **Database reads are defense in depth.** A dedicated MariaDB account has
   SELECT-only grants; GraphJin is also read-only and uses a table/column
   allowlist.
7. **API writes are actions, not agent tools.** The model proposes a semantic
   OpenNeko action. Only an approved worker execution receives a short-lived
   GraphJin role token and invokes the fixed pack operation.
8. **Direct GraphJin mutation remains blocked in agent sandboxes.** Do not relax
   `graphjin-guard.ts` or allow raw `curl` as part of this feature.
9. **Magento credentials are least privilege.** Runtime uses a Magento
   Integration bearer token and a dedicated analytics DB credential. Magento
   admin credentials and Adobe Marketplace/Composer keys are not pack inputs.
10. **Metrics are deterministic.** Shipped cards execute a declared saved query
    and result mapping; an LLM may explain a metric but does not invent its value
    on each refresh.
11. **Writes start with one low-risk operation.** V1 installs only an internal
    order-comment action. Its definition and approval policy are always
    installed; execution readiness depends on GraphJin and Magento API
    preflight. Hold/unhold follows after soak; cancel, refund, shipment, and
    inventory mutation remain disabled.
12. **Upgrade preserves user work.** A pack may update or remove only an
    unchanged artifact it owns. Drift becomes an explicit conflict or detached
    user artifact.
13. **Installation and readiness are separate.** Optional capability failures
    produce `blocked`/`degraded` readiness with a reason and remediation. They
    never cause OpenNeko to omit that capability's artifacts.

## 4. Repository layout

Create the reusable runtime and first pack with this shape:

```text
packages/packs/
  src/
    manifest.ts
    schema.ts
    canonicalize.ts
    planner.ts
    installer.ts
    drift.ts
    health.ts
    artifact-adapters/
  test/

packs/
  schema/solution-pack.v1.schema.json
  magento/
    pack.yaml
    graphjin/
      sources.yaml
      relationships.yaml
      specs/magento-operator-v1.yaml
      saved-queries/
    metrics/
    workflows/
    watchers/
    actions/
    policies/
    skills/
      magento-review-performance/
      magento-investigate-order/
      magento-triage-fulfillment/
      magento-investigate-refunds/
      magento-check-inventory/
      magento-diagnose-platform-health/
      # Each directory contains SKILL.md plus only its focused references.
    migrations/
    fixtures/
    evals/
    docs/

apps/worker/src/packs/
apps/worker/src/actions/adapters/graphjin-api-operation.ts
apps/openneko/cmd/openneko/pack*.go
apps/web/.../packs/
```

`packages/packs` is a private workspace package consumed by the worker and
tests. The Go CLI is a client of the worker/admin control plane; it does not
write metadata Postgres directly.

## 5. Pack manifest V1

Illustrative contract:

```yaml
apiVersion: openneko.app/v1
kind: SolutionPack
metadata:
  id: magento
  name: Magento
  version: 0.1.0
  publisher: openneko
  category: commerce

compatibility:
  openneko: ">=OPENNEKO_PACK_VERSION <NEXT_BREAKING_VERSION"
  graphjin:
    analytics: ">=3.18.42 <4.0.0"
    operator: ">=GRAPHJIN_OPENAPI_MUTATION_VERSION"
  applications:
    - id: magento
      editions: [open-source, adobe-commerce]
      versions: ">=2.4.6 <2.5.0"
  databases:
    - engine: mariadb
      versions: ">=10.6"
    - engine: mysql
      versions: ">=8.0"

inputs:
  - key: magento.base_url
    type: url
    required: true
  - key: magento.store_code
    type: string
    default: all
  - key: magento.table_prefix
    type: string
    default: ""
  - key: magento.base_currency
    type: string
    discover: true
  - key: magento.timezone
    type: timezone
    discover: true
  - key: database.connectivity_mode
    type: enum
    values: [external_network, host_gateway, remote]
  - key: database.host
    type: string
    required: true
  - key: database.port
    type: integer
    default: 3306
  - key: database.name
    type: string
    required: true

secrets:
  - key: database.analytics_username
    purpose: graphjin_source
  - key: database.analytics_password
    purpose: graphjin_source
  - key: magento.integration_token
    purpose: graphjin_api_auth
    required: false

artifacts:
  graphjin:
    sources: graphjin/sources.yaml
    relationships: graphjin/relationships.yaml
    specs: [graphjin/specs/magento-operator-v1.yaml]
    savedQueries: graphjin/saved-queries/
  metrics: metrics/
  workflows: workflows/
  watchers: watchers/
  actions: actions/
  policies: policies/
  skills:
    - skills/magento-review-performance
    - skills/magento-investigate-order
    - skills/magento-triage-fulfillment
    - skills/magento-investigate-refunds
    - skills/magento-check-inventory
    - skills/magento-diagnose-platform-health

health:
  requiredPreflight: [mariadb_connect, mariadb_read_only, magento_version]
  readiness:
    operator: [graphjin_mutations, magento_api_token, magento_api_acl]
  postInstall: [graphjin_reload, analytics_smoke]
  postWriteCanary: [internal_comment_reconciled]
```

Manifest rules:

- Unknown fields fail validation.
- Paths are relative, normalized, and cannot escape the pack root.
- Every artifact has a stable pack-local key and canonical content hash.
- Semver ranges are evaluated before any write.
- Secrets are references; values never appear in the normalized manifest,
  install plan, model context, logs, or `pack_artifact` rows.
- V1 accepts only an embedded, trusted first-party pack. The schema nevertheless
  reserves publisher, signature, and digest metadata for later distribution.
- Pack IDs are simple globally unique slugs (`magento`, `woocommerce`,
  `security`). Category and publisher are separate metadata, not part of the
  ID or CLI command.
- Artifact IDs remain globally stable under the pack slug
  (`magento.metric.net_invoiced_revenue`).
- Artifact declarations are unconditional. Inputs and secrets may affect
  runtime readiness/configuration, but cannot filter metrics, workflows,
  watchers, actions, policies, or skills out of the install plan.

## 6. Metadata and ownership model

Add migrations and Drizzle models for the following tables.

### `pack_install`

| Column | Purpose |
|---|---|
| `id` | Installation UUID. |
| `org_id` | Owning organization. |
| `pack_id` | Namespaced manifest ID. |
| `version` | Desired/installed pack version. |
| `status` | `planning`, `installing`, `installed`, `upgrading`, `failed`, `removing`, `removed`. |
| `manifest_hash` | Canonical manifest/bundle hash. |
| `source` | `embedded` in V1; later registry/file/URL. |
| `installed_by_user_id` | Human actor. |
| `operation_id` | Current install/upgrade saga ID. |
| `last_error` | Redacted terminal error. |
| timestamps | Created, updated, installed, removed. |

One non-removed `(org_id, pack_id)` installation may exist at a time.

### `pack_artifact`

| Column | Purpose |
|---|---|
| `id` | Artifact ownership UUID. |
| `pack_install_id`, `org_id` | Installation scope. |
| `artifact_kind` | source, spec, saved_query, metric, workflow, watcher, action, policy, skill. |
| `artifact_key` | Stable pack-local key. |
| `target_ref` | Actual OpenNeko/GraphJin artifact ID or path. |
| `desired_hash` | Hash from the currently installed pack version. |
| `last_applied_hash` | Hash written by the last successful operation. |
| `ownership` | `managed`, `modified`, `detached`, `retired`. |
| `readiness` | `ready`, `blocked`, `degraded`, or `not_applicable`. |
| `readiness_reason` | Stable non-secret reason code plus remediation metadata. |
| `previous_snapshot` | Encrypted or redacted rollback material where appropriate. |
| `metadata` | Non-secret adapter metadata. |
| timestamps | Created, updated, detached. |

Unique key: `(org_id, artifact_kind, target_ref)`.

### `pack_operation`

Record plan/apply/compensation history:

- ID, install ID, org, type, actor, status, requested version
- redacted plan JSON and plan hash
- started/completed timestamps
- failure phase and redacted error
- compensation status

Append important transitions to the existing audit chain.

### Drift rules

For update or uninstall, calculate the current canonical artifact hash:

- Current hash equals `last_applied_hash`: pack may update/remove it.
- Current hash differs: mark `modified`; default plan preserves it and reports a
  conflict.
- User chooses detach: pack relinquishes ownership and never deletes it.
- Admin explicitly chooses overwrite: record the decision and old snapshot,
  then apply the pack version.
- Artifact already owned by another pack: hard conflict unless the manifest
  declares an exact dependency/shared-owner contract. V1 does not support
  shared ownership.

## 7. Pack lifecycle and control plane

Expose these user operations:

```text
openneko pack list
openneko pack inspect magento
openneko pack plan magento [--upgrade]
openneko pack install magento
openneko pack configure magento
openneko pack status magento
openneko pack doctor magento
openneko pack upgrade magento
openneko pack uninstall magento
```

Required flags/behavior:

- `--output json` for automation.
- `--dry-run` is an alias for plan and never requests secret values.
- Interactive secure prompts for secrets; non-interactive mode accepts secret
  references, not command-line plaintext.
- There is no analytics/operator profile picker and no per-component selection.
  `install` applies every declared pack artifact.
- The default install flow does not stop for a “will install N metrics/actions”
  inventory screen. The explicit `plan` command remains available for change
  control, upgrades, conflicts, and machine-readable automation.
- An omitted Magento Integration token is allowed. The installed operator
  action is marked blocked until `pack configure` supplies a valid token and
  readiness checks pass.
- `--detach-modified` and `--overwrite-modified` require an explicit artifact
  list and admin confirmation.
- `--keep-data` is the default uninstall behavior. Pack-created OpenNeko
  secrets are removed only when unchanged and unreferenced. On GraphJin 3.18,
  uninstall revokes all access to pack sources and retains their inert
  source/table metadata because the control plane cannot safely delete it;
  upgrade this to true source removal once the required GraphJin API ships.
- No destructive `--force` shortcut in V1.

The CLI calls authenticated worker admin endpoints. Add plan, apply, status,
doctor, and uninstall endpoints with admin authorization and idempotency keys.
All mutations go through `AgentControlPlane`/the same audited action boundary as
other administrative writes.

### Install/upgrade saga

1. Load the embedded bundle and validate manifest/schema/path/digest.
2. Check OpenNeko, GraphJin, Magento, and database compatibility.
3. Resolve non-secret inputs and secret references.
4. Run required read-only preflight checks from the actual GraphJin/worker
   network. Evaluate optional capability readiness without filtering artifacts
   or failing the install.
5. Calculate a deterministic create/update/noop/conflict/retire plan.
6. Persist the approved `pack_operation` and acquire an org+pack advisory lock.
7. Snapshot affected managed artifacts and the GraphJin config files.
8. Stage specs, source fragments, relationships, and saved queries in a private
   temporary location; validate the resulting GraphJin configuration.
9. Atomically materialize GraphJin files/config and reload GraphJin.
10. Apply metadata artifacts in a database transaction through typed adapters.
11. Install skills atomically into the org/team skill layer.
12. Run post-install health/smoke checks and persist readiness for every
    capability/artifact.
13. Mark artifact ownership and installation status only after all checks pass.
14. On failure, restore GraphJin files and prior metadata snapshots, reload,
    mark the operation failed, and report any incomplete compensation.

Do not claim a single transaction across Postgres and GraphJin files. This is a
durable saga with explicit compensation and idempotent phases.

## 8. Work breakdown

Sequence and indicative size (`S` = days, `M` = roughly one to two weeks,
`L` = multi-week; estimates exclude the GraphJin release wait):

| Item | Size | Depends on | Hard gate produced |
|---|---:|---|---|
| ON-0 baseline/contracts | S | none | Pin and behavior baseline |
| ON-1 pack engine/provenance | L | ON-0 | Safe install/upgrade foundation |
| ON-2 control plane/CLI/UI | L | ON-1 | Supported operator lifecycle |
| ON-3 analytics source | M | ON-1 | Read-only data plane |
| ON-4 curated OAS3 | M | ON-0 | Reviewed API contract |
| ON-5 deterministic metrics | L | ON-3 | Repeatable cards |
| ON-6 workflows/watchers/skills | M | ON-1/ON-3/ON-5 | Pack intelligence content |
| ON-8 GraphJin upgrade | M | upstream GraphJin release | Released mutation runtime |
| ON-7 governed action | L | ON-2/ON-4/ON-8 | Safe Magento write path |
| ON-9 full E2E/evals | L | ON-3 through ON-8 | Release evidence |
| ON-10 release | M | ON-9 | Shippable pack |

ON-1, ON-3/ON-5, and ON-4 can use separate implementation lanes. ON-7 remains
hard-blocked on ON-8 even if it works against a local GraphJin canary.

### ON-0 — Baseline and contract tests

Deliverables:

- Capture the current OpenNeko version, all GraphJin pins, pack-related schema,
  action policy behavior, OpenAPI importer behavior, metric refresh behavior,
  watcher behavior, and multi-skill installation behavior.
- Add a manifest fixture and failing tests that describe V1 before the engine is
  implemented.
- Add a version-pin inventory test so future GraphJin upgrades cannot update
  only some locations.
- Record the local Magento version/database facts used for development without
  storing credentials.

Exit criteria: tests demonstrate the missing pack lifecycle and enumerate every
GraphJin pin that must move together.

### ON-1 — Manifest parser, planner, and provenance schema

Implementation:

1. Create `@neko/packs` with strict Zod/JSON-schema validation.
2. Implement canonical JSON/YAML normalization and SHA-256 hashing.
3. Add `pack_install`, `pack_artifact`, and `pack_operation` migrations,
   Drizzle schema, stores, and audit-chain events.
4. Implement artifact adapter interfaces:
   - `inspectCurrent`
   - `validateDesired`
   - `plan`
   - `apply`
   - `restore`
   - `remove`
5. Add adapters for GraphJin source/spec/query files, metric, workflow, watcher,
   action definition, action policy, and skills.
6. Implement create/update/noop/conflict/retire planning and drift policy.
7. Add an advisory lock and idempotent operation phase markers.
8. Prohibit scripts/executables and reject path traversal, symlinks escaping the
   bundle, duplicate stable keys, and undeclared references.

Exit criteria:

- Reinstalling the same pack is a no-op.
- A simulated mid-install failure restores prior state.
- Modified user artifacts survive upgrade/uninstall by default.
- Two unrelated packs install concurrently without artifact collision.

### ON-2 — Admin control plane, CLI, and operator experience

Implementation:

1. Add worker admin endpoints for list/inspect/plan/apply/status/doctor/remove.
2. Enforce admin actor, request idempotency, operation locking, and audit.
3. Add the Go CLI commands listed in section 7.
4. Route secret entry through the existing encrypted secret store; never include
   values in plan JSON.
5. Add deterministic plan output grouped by creates, updates, conflicts,
   retired artifacts, required inputs, and health checks for the explicit
   `plan`/upgrade flows. The normal install UX treats the pack as one product,
   not a checklist of components.
6. Add a pack administration center after CLI behavior is stable. Its Magento
   page is the day-2 home: capability health and remediation, last successful
   metric refresh, connection recheck, store scope/timezone/currency, watcher
   thresholds and enable/disable controls, workflow schedules, credential
   rotation, available update, drift conflicts, and safe uninstall. Keep
   artifact counts and GraphJin implementation details behind an advanced
   disclosure. The default surface speaks in outcomes such as Store insights,
   Alerts, Automations, and Approved Magento changes. It never asks a store
   operator to understand "mutations," "write runtimes," or "operator
   capabilities."
7. Show Magento access in plain language: `View only` when OpenNeko can analyze
   but cannot change the store, and `Approved changes available` when at least
   one named change is ready. Do not offer one broad "allow mutations" switch.
   Each shipped change type gets its own explicit control and explanation. V1's
   only control is `Allow private notes on orders`; inventory, refunds,
   cancellations, and shipments have no switch because those changes are not
   present in the pack.
8. Keep `openneko pack manage magento` as the headless/SSH equivalent of that
   page, with status, doctor results, and exact next commands in one response.

Exit criteria: a fresh production stack can plan and install a fixture pack
without direct database access or raw bootstrap SQL.

### ON-3 — Magento connectivity and read-only analytics source

#### Credential setup

The pack requires for analytics:

- `magento_analytics`: a distinct MariaDB/MySQL account with only the SELECT
  grants needed by the curated analytics surface.

A Magento Integration token with the smallest API ACL used by installed
operations is optional at installation time and required only for operator
readiness. If absent, the complete pack still installs and the action remains
blocked with remediation available through `pack status`, `pack doctor`, and
`pack configure`.

The pack must not request or persist:

- Magento admin username/password
- Adobe Marketplace public/private keys
- Composer `auth.json`
- the Magento application database user's broad credential

Provide a reviewed DBA script/runbook that creates the analytics account. V1
does not automatically use a database-admin credential. The doctor command
verifies database grants with read-only probes and must fail the required
analytics preflight if CREATE/INSERT/UPDATE/DELETE/ALTER are possible through
the configured account. A missing/invalid API token is a blocked operator-
readiness result, not an installation failure.

#### Container/network modes

Support:

1. `external_network` — preferred for stacks on the same Docker/OrbStack host;
   the Magento DB joins a named shared network and GraphJin uses its network
   alias.
2. `host_gateway` — GraphJin connects through `host.docker.internal` to an
   explicitly published DB port.
3. `remote` — normal DNS/TLS endpoint.

The installer does not silently publish MariaDB or attach a foreign container
to a network. `doctor` tests connectivity from the GraphJin container and gives
the exact remediation for the chosen mode.

#### GraphJin source

Render a source with:

```yaml
kind: database
type: mysql
read_only: true
analytics_mode: true
capabilities:
  data.read: true
  data.write: false
  schema.read: true
  schema.write: false
access:
  read: authenticated
  write: blocked
  delete: blocked
```

Use an allowlisted Magento analytics surface. Initial tables/views include only
what the shipped queries require, such as:

- `sales_order`, `sales_order_item`
- `sales_invoice`, `sales_invoice_item`
- `sales_creditmemo`, `sales_creditmemo_item`
- `sales_shipment`, `sales_shipment_item`
- `catalog_product_entity` and only required EAV attribute tables
- `catalog_category_product`
- `inventory_source_item`, `inventory_reservation`
- `cataloginventory_stock_item` / applicable stock view
- `store`, `store_group`, `store_website`
- `cron_schedule`, `indexer_state`

Expose customer, address, order, order-history, and operational payment fields
needed for authenticated store operations. Explicitly block admin,
authorization, OAuth, password/reset, raw payment gateway, guest-order secret,
and vault credential tables/columns. PII is classified operational data, not an
unconditional denial rule; deployments may add actor/role restrictions.

Preflight detects Magento table prefix, SQL mode, Magento version, timezone,
websites/stores, base currencies, MSI presence, and required table/column
availability. A non-empty table prefix is rendered into the saved-query/source
artifacts rather than assumed away.

Exit criteria:

- Analytics queries work from the GraphJin container.
- An attempted write is denied by both GraphJin and MariaDB.
- Sensitive tables/columns are absent from GraphJin discovery.
- Multistore, timezone, and currency choices are visible in the install plan.

### ON-4 — Curated Magento OpenAPI 3 contract

Magento 2.4.x exposes an authenticated Swagger 2 schema; current GraphJin and
OpenNeko consume OpenAPI 3. The pack build therefore owns a curated conversion.

Implementation:

1. Add a build tool that fetches the authenticated Magento schema, selects only
   operation IDs/paths on a reviewed allowlist, converts them to OAS3, normalizes
   component names, and emits deterministic YAML.
2. Never store the bearer token or the full authenticated schema in the pack.
3. Validate the emitted file with OpenNeko's importer and GraphJin's loader.
4. Diff path, method, parameters, body schema, response codes, and Magento ACL
   source against the checked-in curated spec.
5. Fail CI when a supported Magento version changes the curated contract.

V1 curated operations:

- `GET /V1/orders/{id}` or its exact Magento service equivalent, for
  precondition/reconciliation.
- `POST /V1/orders/{id}/comments`, for an internal order comment.

The POST operation is explicitly exposed as a GraphJin mutation and restricted
to the short-lived `magento_action_executor` role. `api.delete` is false.

The spec, API-source artifact, action, and policy are installed whether or not a
token exists. Without a ready token/ACL, render the runtime source in a
non-executable posture (`api.write: false` and no executor readiness) and prove
in tests that the unresolved secret reference cannot break GraphJin boot. After
`pack configure` stores a valid token, the pack engine re-renders the same owned
source artifact, reloads GraphJin, reruns readiness, and enables execution. It
does not install a second “operator component.”

Exit criteria: the curated spec is small, hand-reviewable, deterministic,
OpenAPI 3 compatible, and contains no unapproved mutation.

### ON-5 — Deterministic metric execution

Current metric refresh is agent-driven. Add a deterministic mode without
removing the existing agent mode.

Schema change:

- Add `metric.execution_mode` (`agent` or `saved_query`).
- Add `metric.definition_json`, `definition_version`, and `definition_hash`.
- A saved-query definition contains source, saved query name, variables,
  expected result kind, result path, unit/currency, and freshness threshold.
- Validate the definition on write; do not execute arbitrary JavaScript
  transforms. Saved queries should return the final aggregate/series shape.

Worker change:

- `metric-refresh.ts` executes declared saved queries directly for
  `saved_query` metrics, validates the result shape, stores a snapshot, and lets
  the LLM optionally explain the already-computed value.
- Record query definition hash, source freshness, duration, and error class on
  the snapshot/run metadata.

Initial metric set and definitions:

| Metric | Definition |
|---|---|
| Net invoiced revenue | Sum of `base_total_invoiced - base_total_refunded` in the selected period/store scope. |
| Orders placed | Distinct orders created in period; cancellation displayed separately. |
| Average order value | Net invoiced revenue divided by distinct invoiced orders; null when denominator is zero. |
| Refund rate | `base_total_refunded / base_total_invoiced`; explicitly a value rate, not count rate. |
| Cancellation rate | Cancelled orders divided by orders placed. |
| Fulfillment backlog | Paid, non-cancelled order quantities not shipped/refunded. |
| Fulfillment age | Median and oldest age of backlog orders. |
| Sales by store | Base-currency net invoiced revenue grouped by store. |
| Top products/SKUs | Invoiced item value and quantity; refund effects remain in the separate refund metrics. |
| Low/out-of-stock SKUs | Clearly labeled source-quantity approximation unless salable-quantity/MSI reservation calculation is validated. |
| Cron health | Failed/stuck Magento cron jobs over the chosen window. |
| Indexer health | Non-valid indexer states and age. |
| Data freshness | Age of newest order/cron observation and last successful refresh. |

Do not ship conversion-rate metrics without traffic/session data. Do not ship
gross-margin metrics unless cost completeness passes a preflight threshold.

Exit criteria:

- Repeated refresh against unchanged fixtures yields the same value and shape.
- Currency, timezone, period boundary, zero denominator, refunds, cancellation,
  and multistore tests are explicit.
- Metric cards display their calculation note and freshness.

### ON-6 — Workflows, watchers, and task-focused skills

#### Workflows

Install stable, versioned definitions for:

- Daily commerce briefing
- Fulfillment exceptions
- Low-stock investigation and replenishment proposal
- Refund/cancellation spike investigation
- Magento cron/indexer health review
- Customer-service order summary

Schedules and delivery channels are organization-specific. Install scheduled
workflows disabled until the admin confirms timezone, cadence, and output
channel. Manual workflows may be active immediately.

#### Watchers

Install polling watchers for:

- paid order unshipped beyond threshold
- low/out-of-stock SKU count
- refund/cancellation spike
- failed/stuck cron jobs
- invalid/stale indexers
- API authentication and analytics freshness

Threshold-dependent watchers start disabled. Each definition includes cadence,
debounce, severity, dedupe key, cooldown, and linked workflow. Add business-hour
and test-fire support if not already available; avoid creating notification
storms during install.

#### Skills

Ship one discoverable skill per recurring operator task:

- `magento-review-performance`: daily/weekly briefing, revenue, orders, AOV,
  store/SKU mix, and routing to a deeper diagnostic.
- `magento-investigate-order`: one order's invoice, shipment, credit-memo, and
  cancellation timeline, with an optional governed private comment.
- `magento-triage-fulfillment`: backlog, aging, partial shipment, and SLA
  exception prioritization.
- `magento-investigate-refunds`: refund-value and cancellation-rate comparison,
  concentration, and credit-memo reconciliation.
- `magento-check-inventory`: MSI source quantities, reservations, stockouts,
  and replenishment handoff with salable-quantity caveats.
- `magento-diagnose-platform-health`: cron, indexer, data freshness, connection,
  and pack-readiness diagnosis.

Descriptions must be precise enough for automatic selection and explicitly
route overlapping requests to the more specific skill. Keep each `SKILL.md`
focused on its decision procedure; place lifecycle semantics, metric formulas,
MSI behavior, and runbooks in references read only by the relevant skill.

All skills install unconditionally. If write readiness is blocked, the order
investigation remains usable and only its optional private-comment step reports
the readiness reason. No skill contains secrets, local credentials, personal
customer examples, arbitrary REST instructions, or a path around action
approval.

Exit criteria: all artifacts install with stable IDs, appear in their existing
OpenNeko surfaces, carry pack provenance, and survive an idempotent reinstall.

### ON-7 — Governed Magento action adapter

Implement after the GraphJin release has been integrated.

The semantic action definition and approval policy are unconditional pack
artifacts. Maintain a separate action-readiness state with stable reasons such
as `disabled_by_admin`, `graphjin_version_unsupported`,
`integration_token_missing`, `integration_token_invalid`, `acl_missing`, or
`ready`. Recompute readiness on install, configure, doctor, worker startup,
token change, GraphJin reload, and a named action's enable/disable control.
Unavailable actions are visible to admins in plain language and omitted from
ordinary agent action discovery.

#### Declarative action definition

Expose only this semantic input to the agent:

```json
{
  "kind": "magento.add_internal_order_comment",
  "input": {
    "order_id": "42",
    "comment": "Reviewed by operations"
  }
}
```

The pack action definition fixes:

- GraphJin source and OpenAPI operation ID
- mapping of `order_id` to the path parameter
- mapping of `comment` to the request body
- `is_customer_notified = 0`
- `is_visible_on_front = 0`
- precondition query
- post-write reconciliation query
- redaction rules and receipt fields

The model cannot set source, base URL, method, authentication, operation ID,
notification flag, visibility flag, or arbitrary body fields.

#### Execution flow

1. Agent proposes the semantic action.
2. OpenNeko validates input and resolves the installed pack/action version.
3. Default policy is `ask`, approver role admin, with a human-readable preview.
4. After approval the worker mints a short-lived, audience-bound GraphJin JWT
   carrying only `magento_action_executor`; include action request ID as `jti`.
5. The token is held only in worker memory and is never injected into an agent
   sandbox.
6. Worker executes the fixed GraphJin mutation through its internal client.
7. Worker reads the order/comment endpoint to reconcile the result.
8. `action_execution` stores source, operation, status, Magento reference,
   correlation ID, request hash, response hash, and redacted summary.
9. Ambiguous timeout/network outcomes enter `reconcile_required`; they are not
   automatically replayed.

Add a generic internal `graphjin_api_operation` adapter, but do not expose that
generic kind to agents. Packs expose reviewed semantic action kinds backed by a
restricted mapping DSL with constants, input references, and result paths—no
templates capable of arbitrary code execution.

#### Guard hardening

- Keep direct GraphQL mutation text blocked in `graphjin-guard.ts`.
- Resolve saved-query metadata before executing a saved query/workflow and
  block saved mutations for ordinary agent runs; a mutation must not bypass the
  guard merely because its text is stored under a name.
- Ordinary run tokens must fail GraphJin's operation `allowed_roles` check even
  if the wrapper is bypassed.
- Raw HTTP access to GraphJin remains blocked from the sandbox.

Exit criteria:

- Installing without a Magento Integration token still installs the action and
  policy and reports `integration_token_missing`.
- Supplying a valid token through `pack configure` changes readiness without
  creating or replacing pack artifacts.
- No action executes before approval.
- Exactly one internal comment is created and reconciled.
- Customer notification and storefront visibility remain false.
- Denied, expired-token, wrong-role, duplicate approval, timeout, and ambiguous
  result cases have explicit tests.

### ON-8 — Upgrade OpenNeko's GraphJin version

Start only after the upstream release handoff provides the exact version,
release commit, Docker digests, and immutable GitHub asset IDs.

Update all active pins together:

- `compose.yml`
- `compose.adventureworks.yml`
- `apps/openneko/assets/compose/core.yml`
- `apps/openneko/assets/compose/demo.yml`
- both `GRAPHJIN_VERSION` arguments in `Dockerfile`
- `GRAPHJIN_ASSET_AMD64` and `GRAPHJIN_ASSET_ARM64` in `Dockerfile`
- `scripts/install-clis.sh`
- `packages/llm/src/graphjin/version.ts`
- `packages/records/src/graphjin/config.ts`
- version assertions/fixtures under `apps/worker/test`,
  `packages/records/test`, and related tests
- comments in active example/config files that claim the current version

Do not rewrite historical migration comments solely to make the number look
current when they describe behavior introduced in 3.18.42.

Add one source of truth or a CI consistency test that scans all runtime pins and
fails on disagreement. Docker asset IDs and semver are a coupled tuple.

Compatibility test matrix:

| Runtime | Required check |
|---|---|
| customer GraphJin | source/agentic config loads, read queries, saved queries, config reload |
| metadata `neko-graphjin` | migrations, workflow/action tables, watch store, healthcheck |
| records GraphJin | version gate, schema lifecycle commands, policy projection |
| CLI in runtime images | `graphjin version` equals the expected pin on amd64 and arm64 |
| OpenAPI importer | current OAS3 reads plus Magento mutation spec |
| agent sandbox | existing read commands work; direct mutation remains blocked |

Run a production-mode soak before enabling the pack write action. Keep the
previous GraphJin semver tag as the rollback pin, but do not roll back after an
ambiguous Magento action without reconciling it first.

Exit criteria:

- Every pin reports the released version.
- OpenNeko build/test and prod smoke tests pass.
- Records, metadata, and customer GraphJin instances are healthy.
- The Magento pack compatibility check accepts the new release and rejects the
  old 3.18.42 pin.

### ON-9 — End-to-end fixtures and evaluation

The local sample catalog is useful for exploration but contains too few orders
for stable metric assertions. Build deterministic fixtures through supported
Magento service/setup interfaces, not ad hoc writes into Magento application
tables.

Required fixture scenarios:

- two stores and base/display currency distinction
- orders spanning timezone boundaries
- invoiced and partially refunded order
- cancelled order
- paid/unshipped and partially shipped order
- repeat customer represented with minimized test PII
- MSI source stock plus reservations
- low-stock/out-of-stock SKU
- failed cron and invalid/stale indexer state in an isolated test environment
- designated order for an internal-comment mutation

Test layers:

1. Manifest/schema/canonical hash unit tests.
2. Planner, drift, rollback, idempotency, and conflict tests.
3. Artifact adapter integration tests against metadata Postgres/temp GraphJin
   config.
4. MariaDB privilege and sensitive-discovery tests.
5. Saved-query metric golden tests.
6. Workflow/watcher scheduling, debounce, dedupe, and test-fire tests.
7. Action policy/approval/JWT/adapter/reconciliation tests.
8. Full OrbStack/Docker production-stack installation against local Magento.
9. Upgrade from previous pack version with one unmodified and one user-modified
   artifact.
10. Uninstall proving user modifications and Magento data are preserved.

Safety assertions after the write canary:

- one and only one expected order-history entry was created
- no email/customer notification was requested
- order status, totals, shipment, invoice, refund, and inventory are unchanged
- no automatic retry occurred
- action request, approval, execution, GraphJin correlation, and reconciliation
  are linked in the audit trail

### ON-10 — Documentation, packaging, and release

Documentation:

- Prerequisites and supported Magento versions/editions
- Creating a least-privilege analytics DB account
- Creating/revoking a least-privilege Magento Integration
- External-network vs host-gateway setup for Docker/OrbStack
- Multistore/currency/timezone choices
- Metric definitions and caveats
- Action approval and audit behavior
- Doctor output and troubleshooting
- Upgrade, drift resolution, detach, and safe uninstall
- Privacy/data declaration
- Explicit statement that Adobe Marketplace keys are unrelated to pack runtime

Packaging:

- Produce a deterministic pack bundle and SHA-256 digest.
- Generate an SBOM/license inventory for bundled material.
- Sign the first-party bundle when a project signing mechanism is available;
  embedded V1 still records its build digest.
- Include manifest version and compatibility contract in OpenNeko release notes.

Release gates:

- The exact GraphJin released version is pinned everywhere.
- The pinned GraphJin release allows the positive Magento customer-ID/email
  canary, enforces secret-column blocklists on both direct tables and logical
  table aliases, and rejects the negative guest-order protect-code canary.
- Full OpenNeko CI and Magento pack E2E are green.
- Fresh install, no-op reinstall, upgrade with drift, doctor, rollback simulation,
  and safe uninstall pass.
- No credentials, admin tokens, Marketplace keys, production customer PII, or
  full authenticated Magento schema are committed. Customer PII remains
  queryable from the customer's connected store at runtime.
- Operator action defaults to approval-required.
- Cancel/refund/ship/inventory mutations are absent, not merely hidden in UI.

## 9. Initial pack content inventory

Each item receives a stable artifact key and a definition hash.

### GraphJin

- `source.magento_analytics`
- `source.magento_operator`
- `spec.magento_operator_v1`
- reviewed Magento relationship overlays
- saved queries for each metric, watcher, precondition, and reconciliation
- explicit table/column blocklist

### Metrics

- net invoiced revenue
- orders placed
- average order value
- refund rate
- cancellation rate
- fulfillment backlog
- fulfillment age
- sales by store
- top products/SKUs
- low/out-of-stock SKUs, labeled with its inventory semantics
- cron health
- indexer health
- data freshness

### Workflows

- daily commerce briefing
- fulfillment exceptions
- low-stock investigation
- refund/cancellation spike investigation
- cron/indexer health review
- customer-service order summary

### Watchers

- aged fulfillment backlog
- stock threshold
- refund/cancellation spike
- cron failure/stall
- indexer invalid/stale
- API auth/data freshness

### Actions/policies

- `magento.add_internal_order_comment`
- default policy `ask`, admin approver
- fixed notification/visibility safety constants
- precondition and reconciliation definitions

### Skills

- `magento-review-performance`
- `magento-investigate-order`
- `magento-triage-fulfillment`
- `magento-investigate-refunds`
- `magento-check-inventory`
- `magento-diagnose-platform-health`

## 10. Pull-request sequence

Recommended sequence:

1. **PR 1:** manifest/schema/canonicalization and fixture tests (ON-0/ON-1
   foundation).
2. **PR 2:** provenance tables, stores, planner, drift, rollback engine.
3. **PR 3:** worker control plane and Go CLI lifecycle commands.
4. **PR 4:** Magento DB preflight, connection modes, authenticated operational
   reads, and secret-data blocklist.
5. **PR 5:** deterministic metric mode and Magento saved queries/cards.
6. **PR 6:** workflows, watchers, task-focused skills, and pack artifact bundle.
7. **PR 7:** curated Swagger 2 -> OAS3 build/verification pipeline.
8. **PR 8:** GraphJin released-version pin upgrade and compatibility soak
   (blocked on upstream release).
9. **PR 9:** generic internal GraphJin API adapter, semantic Magento action,
   guard hardening, reconciliation.
10. **PR 10:** full Magento E2E, admin UI, docs, bundle integrity, and release.

PRs 1-7 can progress while GraphJin is being implemented, using a local canary
only in development. PR 8 is the hard production gate for PR 9.

## 11. Test commands and merge evidence

Use targeted commands during development and the full suite at phase gates:

```sh
pnpm --filter @neko/packs test
pnpm --filter @neko/db test
pnpm --filter @neko/llm test
pnpm --filter @neko/worker test
pnpm --filter @neko/worker test:e2e
pnpm --filter @neko/web test
pnpm --filter @neko/web typecheck
(cd apps/openneko && go test ./...)
pnpm build
pnpm lint
```

The production E2E evidence should also capture, with secrets redacted:

- `openneko pack plan/install/status/doctor` output
- GraphJin version from every runtime image
- MariaDB grant verification
- sensitive-table discovery denial
- metric golden results
- watcher dedupe behavior
- action approval and reconciliation receipt
- upgrade-with-drift and uninstall results

## 12. Rollout

1. **Internal alpha (`0.2.x`):** embedded complete pack; write action installed
   but blocked by readiness by default.
2. **Operator canary:** upgraded released GraphJin, one designated Magento test
   environment, internal-comment readiness enabled for admins only.
3. **Beta:** selected non-production Magento installations, action still
   approval-required, doctor telemetry and compatibility failures reviewed.
4. **V1:** documented compatibility range, signed/digested bundle, stable
   upgrade/uninstall contract, no high-risk mutations.
5. **Post-V1:** hold/unhold behind approval after soak. Evaluate shipment and
   inventory only with operation-specific idempotency/reconciliation. Refund and
   cancellation require separate risk review.
6. **WooCommerce:** reuse the pack engine, deterministic metric contract,
   governed API adapter, provenance, lifecycle, and task-focused operator skill structure;
   replace only platform-specific sources, queries, actions, and knowledge.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Pack lifecycle becomes demo-installer v2 | Separate typed pack engine; no exclusivity, Compose requirement, or raw SQL bootstrap. |
| Magento API schema is huge and ACL-dependent | Curated OAS3 allowlist generated and reviewed per supported version. |
| DB credential exposes customer/payment data | Dedicated SELECT grants plus GraphJin table/column deny/allowlist and discovery tests. |
| Agent bypasses action approval | Ordinary role cannot invoke GraphJin operation; executor JWT exists only after approval in worker memory. |
| Duplicate writes after timeout | No automatic retries; reconcile ambiguous outcomes before any replay. |
| Pack upgrade overwrites user customization | Hash-based drift detection, preserve/detach default, explicit per-artifact overwrite. |
| Metadata transaction succeeds but GraphJin reload fails | Durable saga with snapshots, atomic file materialization, health gate, compensation. |
| Metrics are semantically misleading | Checked-in formulas, currency/timezone/store scope, calculation notes, golden fixtures. |
| GraphJin pin drift across images/CLI | One inventory/consistency test; bump semver and immutable asset IDs together. |
| Sample catalog is too sparse | Deterministic Magento fixture scenarios independent of the existing sample orders. |
| Missing write credentials create a confusing partial install | Always install the full artifact set; expose a separate readiness state and `pack configure` remediation. |

## 14. Definition of done

The OpenNeko work is done only when:

- The reusable solution-pack lifecycle exists with provenance, plan, drift,
  upgrade, rollback, doctor, and safe uninstall.
- Magento analytics uses a verified SELECT-only account and exposes no sensitive
  tables/columns.
- Shipped metrics are deterministic and documented.
- Workflows, watchers, skills, actions, and policies install with stable IDs and
  pack ownership regardless of write readiness.
- The released GraphJin mutation version is pinned consistently across every
  OpenNeko runtime and has passed compatibility soak.
- The internal-comment action requires approval, uses a short-lived executor
  role, is reconciled, and cannot notify the customer or appear on the
  storefront.
- Fresh install without an Integration token succeeds with the action blocked;
  adding a valid token changes only readiness/configuration, not artifact
  membership.
- Fresh install, reinstall, upgrade with drift, failure compensation, doctor,
  and uninstall pass in the production stack against the Magento fixture.
- The pack bundle contains no secrets or high-risk Magento mutations.
