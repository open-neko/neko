# Issue #290: custom-pack installation

Source: https://github.com/open-neko/openneko/issues/290

## Agreed scope

Implement the smallest complete custom-pack installation path. Magento is a
first-party pack and must use the same installation method as uploaded packs.
Packs needing connectors ship their own connector definitions and assets; pack
installation must not depend on the plugin marketplace or plugin runtime.
Use Ponytail to reuse existing code and avoid speculative infrastructure.

These instructions supersede the issue's proposed signed-plugin dependency
architecture. Records applications, OAuth discovery, and the broader application
lifecycle are deferred from this minimal installation change unless required by
the proof pack. Do not claim the original issue's entire checklist is complete.

## Todo

### 1. Establish the implementation boundary

- [x] Read issue #290 and trace the current upload/install boundary.
- [x] Locate the failed worktree: `../openneko-issue-290` on
  `feat/issue-290-solution-pack-installer`; inspect its scope without merging it.
- [x] Install and load Ponytail 4.9.0.
- [x] Finish tracing install, configure, upgrade, uninstall, runtime consumers,
  CLI, and Admin Packs callers before changing their shared contracts.
- [x] Select one small custom proof pack, including a pack-owned connector,
  and record exactly what the existing connector substrate supports.

Done when: the required behavior and concrete proof pack are clear, with no
plugin dependency or second installation engine.

### 2. Make the existing installer work for every pack

- [x] Remove the Magento-only eligibility gate from the shared installer.
- [x] Drive generic artifacts, configuration, source bindings, schedules, and
  readiness from pack declarations rather than Magento defaults.
- [x] Keep Magento-specific discovery and checks confined to its first-party
  behavior while sharing planning, apply, ownership, and compensation.
- [x] Verify configure, upgrade, and uninstall through the same shared path.

Done when: the proof pack and Magento both install through `PackService` with
working artifacts, ownership checks, idempotency, and failure compensation.

### 3. Support connectors shipped inside packs

- [x] Reuse pack source declarations and bundled OpenAPI/spec assets where they
  cover the proof connector; identify any actual missing runtime support.
- [x] Validate bundled connector definitions and secret references before apply.
- [x] Verify connector reads and keep writes under existing action policy.
- [x] Prove that installation and execution do not install or load plugins.

Done when: an installed custom pack can use its bundled connector, credentials
remain protected, and unapproved writes stay blocked.

### 4. Add safe, persistent upload and review

- [x] Finish and test ZIP staging in `packages/packs/src/archive.ts`.
- [x] Reject unsafe paths, links, executable files, nested archives, duplicates,
  excessive expansion, malformed bundles, and first-party ID collisions.
- [x] Store validated packs in the organization workspace with provenance;
  failed/interrupted uploads must never become discoverable installations.
- [x] Include uploaded packs in listing, inspection, and planning.
- [x] Bind explicit install approval to the reviewed bundle/plan; make identical
  uploads idempotent and reject changes to an approved version.
- [x] Verify organization isolation and persistence across restart and backup.

Done when: uploading stages an inspectable pack without activating any artifact,
and approved installation uses the exact reviewed content.

### 5. Expose the path through CLI and Admin Packs

- [x] Add admin-only bounded upload API and `openneko pack upload <archive>`.
- [x] Make CLI installation accept custom packs and their declared configuration.
- [x] Extend the existing Packs page with upload, review, configuration, install,
  and status using shared UI primitives; retain Magento management behavior.
- [x] Read the required web skills and Next.js guidance before editing web code.
- [x] Verify desktop/phone loading, success, validation error, failed install,
  focus, and disabled states in the rendered UI; record the reuse map.

Done when: an administrator completes upload → review → configure → install
through supported UI and CLI paths without copying files or rebuilding images.

### 6. Prove the complete path and review the diff

- [ ] Run focused archive, authorization, approval, ownership, and lifecycle
  regression checks, including failed-install compensation.
- [ ] Install the custom proof pack in a real runtime and exercise its connector
  and dependent artifacts; verify uninstall disables owned automation.
- [ ] Run Magento regression checks and verify its shared installation path.
- [ ] Verify upgrade preserves operator changes/data and restart preserves packs.
- [ ] Run affected typechecks/tests and required web checks; inspect failures.
- [ ] Review with Ponytail: remove unused dependencies, duplicate paths,
  speculative abstractions, and unrelated changes.
- [ ] Document packaging/install commands and report verified behavior and limits.

Done when: evidence supports the narrowed scope, the change is reviewable, and
this checklist accurately distinguishes completed work from deferred features.

## Working rules

Update this file as each chunk progresses. Finish and verify one coherent chunk
before broadening the implementation. Preserve unrelated `prototypes/` content
and the failed worktree's uncommitted changes. Do not commit, push, or merge
without the user's instruction.


## Step 1 evidence and decisions — 2026-09-08

Step 1 is complete. This is a source-grounded boundary and proof specification;
custom installation and connector execution have not yet been implemented or
verified. Existing `@neko/packs` tests passed: 2 files, 27 tests.

### Shared flow to preserve

| Surface | Current code and behavior | Required change |
| --- | --- | --- |
| Bundle and plan | `packages/packs/src/{manifest,bundle,planner}.ts` validate declarations, load artifacts, hash content, and calculate create/update/noop/conflict/retire. | Reuse them. Validate real compatibility and uploaded content; allow a connector-only pack without fabricated database requirements. Empty skills currently fail validation, including generator output without a skill. |
| CLI | `apps/openneko/internal/cli/pack.go` calls worker routes; install explicitly rejects non-Magento IDs and install/configure flags are Magento-specific. `root.go:MaybeProxyToWorker` re-executes commands in the selected worker container. | Generic inputs and review/install arguments. Upload must transport the host archive; its host path is not automatically available inside the container. |
| Web/API | `apps/web/src/app/admin/settings/packs/page.tsx` renders `MagentoPackAdmin`. The API routes call `requireAdminActor`, then forward to the worker. | Add generic catalog/review/configuration while retaining Magento management. Preserve solo-admin and authenticated-admin semantics. |
| Worker routing | `apps/worker/src/admin-server.ts` dispatches pack routes; `index.ts` constructs one `PackService(ADMIN_ORG_ID)`. Worker pack routes trust the internal caller and have no independent session authentication. | Keep the deployment-org boundary explicit. New upload/approval routes must preserve the trusted internal transport and admin-facing gate. Do not trust a supplied org/user identity. |
| Install/configure/upgrade | `apps/worker/src/packs/service.ts` routes all three to `apply`. It locks per org/pack, rechecks idempotency, validates inputs/secrets, checks drift/native ownership, installs files/GraphJin/skills, and commits native rows and provenance. | Generalize this method. Preserve one lifecycle for Magento and custom packs; isolate Magento discovery/readiness/defaults, not the installation method. |
| Failure handling | The same service compensates filesystem, GraphJin and secret changes on caught failures. Operation phases are durable, but restore callbacks are in memory. Skills and GraphJin can become visible before the final DB transaction. | Do not describe existing compensation as crash-resumable or activation as fully atomic. Test interruption and staged visibility at the upload/apply boundaries. |
| Status/doctor | `status` derives analytics/operator readiness; `doctor` always runs Magento connection and sales-order checks. | Derive generic checks from the installed pack; preserve Magento-specific evidence only for Magento. |
| Uninstall | `uninstall` uses provenance, preserves drifted resources, disables native artifacts, removes owned files/skills, revokes GraphJin source access, and retains installation history. It also deletes the pack secret section. | Reuse it, distinguishing owned sources/secrets from references to existing administrator resources. Uninstall must use installed-version provenance even when a newer upload is staged. |
| Runtime reads | `apps/worker/src/jobs/metric-refresh.ts` and `packages/llm/src/workflows/watchers.ts` query the org's preferred enabled GraphJin endpoint. Metrics do not select an endpoint from `execution.source`. The installer hardcodes Magento variables/timezones. | Bind and persist the reviewed endpoint/source identity; ensure preflight and subsequent reads use it. Use declared variables and schedule timezone. |
| Runtime writes | `packs/action-preflight.ts` gates pack-owned actions; `packs/magento-v2-runtime.ts` registers Magento's specific governed adapters. Merely storing an action definition does not register an executor. | Preserve Magento action policy and executors. Reject unsupported custom write adapters before apply; never infer an arbitrary-write executor from a pack. |
| Storage | `pack_install.source` in migration 0059 permits only `embedded`. Org workspaces live under `.config/openneko/agents/orgs/<org>/`. Compose backup snapshots include the config volume. | Add uploaded provenance/storage within that existing workspace, mirrored CLI migration, and explicit restore verification. No new storage service. |

### Connector boundary

Use the existing pack artifact contract: `artifacts.graphjin.sources` plus
`artifacts.graphjin.specs` containing bundled OpenAPI files. These definitions
and files are the connector shipped by the pack. A second connector manifest,
plugin dependency resolver, package installer, or executable-loader framework
is not needed for this proof.

`service.ts:graphjinUpdate` currently builds Magento source configuration by
hand. `installGraphjinFiles` already materializes bundled specs and saved queries.
`graphjin-config.ts:applyPackGraphjinConfig` already uses GraphJin preview/apply,
source ownership checks, config locking, persistence, and supervisor reload.
Its credential persistence uses `gjsecret://` references. Generalize declaration
translation and reuse that path; do not put plaintext secrets into YAML templates.

The OpenNeko source demonstrates an OpenAPI/bearer configuration path, not a
verified generic connector installer. Step 3 must prove the custom spec's query
root, response mapping, credential sealing, connectivity, and restart behavior
against the actual packaged GraphJin runtime. Current spec validation checks
only basic OpenAPI structure; uploaded specs need stricter checks before apply.

No pack will install or execute a plugin. The existing secret-store utility is
currently imported from `@open-neko/plugin-install/secrets`; this is encrypted
storage, not a connector runtime. Reuse the encrypted store without adding a
plugin lifecycle; if the dependency must be removed, move/re-export that utility
from a neutral module instead of creating a second secrets store.

Generic OAuth consent/refresh, custom executable connector code, and custom
write execution are outside this first connector proof. Bundled declarative
connectors that need those unsupported features must fail validation explicitly.
Magento retains its existing governed write behavior.

### Concrete proof pack: `service-health`

The fixture will live under test fixtures, outside the embedded `packs/` catalog.
It must upload and install without a source-code registration or image rebuild.

- Identity: `service-health`, version `0.1.0`, publisher `fixture`.
- Configuration: `service.base_url` (required URL) and `service.timezone`
  (timezone, default `UTC`); `service.api_token` is a required write-only secret.
- Bundled connector: `graphjin/sources.yaml` declares API source
  `service_health`; `graphjin/specs/service-health.yaml` describes authenticated
  `GET /health-summary`, operation ID `getHealthSummary`.
- Provider response: `{ "healthy": 1, "checked_at": "<ISO timestamp>" }`.
  A local test HTTP server supplies the response and verifies the bearer token;
  that server is test infrastructure, not executable code in the uploaded pack.
- Query: one saved GraphQL query for the operation. Capture and validate its
  actual GraphJin root and response shape in step 3; do not guess the mapping.
- Artifacts: one scalar health metric, one watcher for healthy < 1, one scheduled
  health-review workflow also targeted by the watcher, and one Markdown skill.
  Relationships are empty; no action/policy or Records resource is required.
- Readiness: missing/wrong token, invalid spec, inaccessible endpoint, or wrong
  response shape blocks activation. Uploaded/unapproved content has no active
  effect. A POST/DELETE attempt must be denied and leave provider state unchanged.
- Lifecycle proof: identical retry is a no-op; version `0.2.0` changes the
  workflow description; an operator-edited workflow conflicts rather than being
  overwritten. Reconfigure retests a changed URL/token. Uninstall disables
  automation and connector access while retaining metric and operation history.
- Shared-method proof: Magento and `service-health` enter the same `apply` flow;
  only first-party discovery/checks and existing Magento action execution differ.

Separately retain the original generator compatibility check: a database-only
pack containing `{ name, kind: database }` binds an explicitly selected existing
org source. It must not create or take ownership of that administrator source,
and uninstall must not revoke it. This catches a different boundary from the
owned API connector without enlarging the proof pack.

### Minimum implementation boundary

Reuse `PackService`, the existing artifact loader/planner, GraphJin config apply,
and encrypted store. Change their declarations/callers only where the table
above identifies a blocker. Add upload persistence and UI/CLI entry points in
their later chunks. Preserve the existing Magento pack and management behavior.
The failed branch remains evidence only; its 232-file rewrite is not a base for
this implementation. No production code was changed during step 1.


## Step 2 complete — 2026-09-08

Custom read-only packs and the full Magento bundle use the existing
`PackService.apply` for install, configure, and upgrade, with the existing
planner, ownership, idempotency, compensation, and uninstall implementation.
Magento discovery, defaults, readiness, and governed action behavior remain
first-party checks within this shared lifecycle.

Generic configuration resolves declared values and credentials, query variable
descriptors, workflow timezone, and readiness checks. Unsupported write adapters,
unknown checks, unsafe sources/spec references, missing variables, ambiguous
database queries, and non-read-only GraphQL fail validation. Empty skills,
relationships, and connector-only database compatibility lists are supported.

An explicit enabled organization data-source selection is persisted and used by
preflight, metrics, watchers, and Magento action runtime. Disabled, changed, or
cross-organization endpoints cannot silently replace it. Thin database source
references bind to administrator-owned read-only sources; install and uninstall
do not take ownership of or revoke those sources.

Database reads use pack-specific table aliases, preserving GraphQL response names.
The direct runtime check found that GraphJin accepts `@database` but routes root
execution using configured table mappings. The installer therefore materializes
both the query and its table mappings using GraphJin's existing config apply.
It retains alias ownership across reconfiguration/upgrades and checks mappings
before runtime reads. Existing unrelated mappings are not overwritten. Alias
metadata is retained on uninstall under the existing GraphJin compatibility
policy; owned automation and query files are disabled/removed, and borrowed
sources remain accessible under their administrator-defined permissions.

### Verification

- 85 distinct focused tests passed: 53 worker tests, 27 pack package tests,
  and 5 watcher integration tests. Worker and packs typechecks passed;
  `git diff --check` passed.
- The shared lifecycle suite used PostgreSQL 16 with all metadata migrations
  and real temporary files/skills. It verified custom install, identical retry,
  configure, upgrade, drift conflict, failed-preflight compensation, doctor,
  and uninstall; declared variables/timezone/readiness; real metric-refresh and
  watcher consumers; endpoint isolation; two concurrent borrowers; rebinding;
  altered-routing rejection; and the full first-party Magento bundle lifecycle.
- GraphJin transport/config apply, Magento external preflight, and queue transport
  are substituted in that lifecycle suite. It is not a live bundled-connector
  or Magento provider acceptance test.
- A separate direct GraphJin-core check used two real PostgreSQL databases with
  the same `health` table containing different values. It ran the query/table
  definitions emitted by `bindPackQueries`: the default database returned `111`,
  while the selected `customer_db` returned `222`. This used the local GraphJin
  checkout (HEAD `71cfb7abb9cc13904bf14f7f0633a64f0183cd34`), not the packaged
  connector runtime. Output: `/tmp/issue290-routing.log`.
- Disposable container `openneko-pack-shared-test` was removed after verification.
  The failed worktree and unrelated `prototypes/` were untouched. No commit/push.

Reproduce the lifecycle tests against a disposable, migrated metadata database:

```sh
OPENNEKO_PACK_LIFECYCLE_TEST=1 OPENNEKO_PG_ENV_OVERRIDE=1 NEKO_PG_HOST=127.0.0.1 NEKO_PG_PORT=<test-port> NEKO_PG_USER=neko NEKO_PG_DATABASE=neko pnpm --filter @neko/worker test -- test/pack-lifecycle.integration.test.ts
```

The suite scopes rows to a unique organization and temporary config/workspace.
At step 2 completion, steps 3–6 remained pending. Bundled connector execution against the
packaged runtime, upload persistence, and CLI/Admin UI are not completed by step 2.
`packages/packs/src/archive.ts` remains unintegrated and behaviorally unverified.


## Step 3 complete — 2026-09-08

The `service-health` fixture ships its source declaration and OpenAPI asset,
with bearer credentials supplied at install time. It uses the existing
`PackService` and GraphJin config preview/apply/restart path. No connector code,
plugin installer, registry, or new execution engine was added.

The live test uses the packaged GraphJin **3.20.47** image, verified by its
`graphjin version` output, plus disposable PostgreSQL and a real authenticated
HTTP provider. The image used was
`sha256:93b6d3662a92e92c097c432240ac2a09828e3064158940e4b48caab66c10c855`.
The verified query root is `service_health_get_health_summary`, with metric and
watcher result path `service_health_get_health_summary.healthy`.

### Changes found necessary by live testing

- A rejected token replacement restored the previous YAML but left the encrypted
  GraphJin token overwritten at its stable `gjsecret://` reference. The shared
  config helper now restores the encrypted keystore with the configuration.
  Rollback takes the existing config lock and refuses to overwrite a subsequent
  configuration/keystore change.
- Generic readiness now rejects a null/missing scalar metric path instead of
  letting the legacy numeric mapper convert null to zero.
- No additional connector runtime was needed. The proof fixture and opt-in
  Docker integration test are under `apps/worker/test/`.

### Evidence

`pack-connector.integration.test.ts` passed against the real packaged runtime:

- Missing credentials and external OpenAPI references fail before installation
  state is created.
- Installation, doctor, metric refresh, and watcher execution read the bundled
  connector; the real metadata database records health value `1`.
- Configuration contains sealed `gjsecret://` references; neither configuration,
  encrypted keystore, installation config, nor operation plans expose the token.
- A complete GraphJin container restart retains authenticated connector reads.
- The spec includes POST and DELETE operations. GraphJin excludes those mutations
  from this read-only connector, attempted mutation calls fail, and the provider
  receives **zero writes**. Existing Magento action adapters/policy are unchanged;
  unsupported custom write adapters still fail validation.
- Wrong credentials, an unreachable endpoint, and a null health result reject
  reconfiguration. Compensation restores the working connector each time.
- Uninstall prevents further provider reads. A later operator config change is
  preserved when rollback is attempted.
- The test throws if the plugin installer or worker plugin registry is loaded.
  It passes with both traps active. Only the existing encrypted-secret utility
  subpath is reused; no plugin lifecycle is required.

Only queue enqueueing and the workspace location are substituted in this test;
GraphJin transport, config apply, restart, provider HTTP, secret storage, metadata,
metrics, and watcher queries use the real implementations. Docker containers and
temporary workspaces are cleaned up by the test.

Reproduce with Docker running and the packaged image available locally:

```sh
OPENNEKO_PACK_CONNECTOR_TEST=1 pnpm --filter @neko/worker test -- test/pack-connector.integration.test.ts
```

The test verifies image version 3.20.47 and creates/migrates its own disposable
metadata database. Its fixture's empty action/policy directories are created by
the test, since Git does not track empty directories.

The live test, 27 focused worker regressions, worker typecheck, and
`git diff --check` passed. Logs: `/tmp/issue290-connector.log` and
`/tmp/issue290-step3-regression.log`. Nothing was committed or pushed.
Steps 4–6 remain pending: this proves the connector installation/runtime boundary,
not archive upload persistence or an administrator UI/CLI upload flow.

## Step 4 complete — 2026-09-08

`PackService.upload`, `inspect`, `list`, `plan`, and `review` now accept uploaded
packs. Installation/configuration/upgrade continue through the existing shared
apply engine. Upload itself only publishes validated files; it never activates
native artifacts or connector access. API, CLI, and Admin UI entry points remain
step 5.

ZIP extraction uses a private staging directory, bounded streaming, CRC/size
checks, and declarative text files only. Limits are 16 MiB compressed, 64 MiB
expanded, 8 MiB per file, 1,000 entries, depth 16, and compression ratio 100.
Unsafe paths, case-ambiguous paths, duplicate entries, links, executable content,
nested archives, malformed bundles, and first-party pack IDs are rejected.
Failed staging is removed and incomplete staging is absent from discovery.

Complete versions are atomically published beneath the organization's config
workspace: `<config-dir>/agents/orgs/<encoded-org-id>/packs/<pack-id>/versions/`.
The config directory is used deliberately: Docker backs up that volume, while
its separate agent-home volume is not included in the encrypted config snapshot.
An atomic candidate pointer controls discovery. Provenance records organization,
uploader, timestamp, archive hash, bundle hash, and a hash of every content file
and directory. Identical uploads preserve provenance; any changed bytes require
a new version. Completed orphan versions can be published by an identical retry.

Review returns an organization-keyed approval hash covering the exact content,
operation, actor, configuration, resolved credentials, source bindings, and
current native plan. Uploaded applies require that hash and recheck it before
activation. Credentials are not returned or persisted in the review plan.
Application uses a verified private snapshot, and the installed content identity
is pinned in `pack_install.config._bundle`. Configure, doctor, and uninstall use
the installed version even when a newer candidate exists or its pointer is gone.
Migration `0070_uploaded_packs.sql` permits `source='uploaded'`; the embedded CLI
migration copy is identical.

### Verification

- **66 distinct focused tests passed:** 30 pack tests, 30 worker unit/storage
  tests, 4 PostgreSQL shared-lifecycle tests, and 2 packaged-runtime integration
  tests. Worker and packs typechecks, migration-copy comparison, and
  `git diff --check` passed.
- Archive checks cover hostile paths/types/content, corruption, compression and
  aggregate expansion limits, malformed bundles, reserved IDs, and cleanup.
  Storage checks cover concurrent identical uploads, changed-version rejection,
  orphan recovery, organization provenance, tampering, and private snapshots.
- The real GraphJin 3.20.47/PostgreSQL/provider test verifies upload without
  activation; review rejection for changed actor, configuration, credentials,
  content, candidate version, and operator-edited native state; approved install,
  idempotent replay, configure, upgrade, doctor, and uninstall.
- The current Docker `neko-backup` target was built locally. The live test runs
  the production `snapshot_configs` and `decrypt_snapshot` functions to encrypt
  and restore the config volume. A fresh Node process loads the restored catalog
  and credential/signing-key storage and reproduces the same approval hash.
  Restored files then support actual configure, upgrade, reads, and uninstall.
  This proves the new pack/config persistence boundary; it is not a new full
  PostgreSQL disaster-recovery acceptance test.
- The shared regression suite also passes the complete first-party Magento
  lifecycle with its documented external-preflight/GraphJin substitutions.
  Disposable containers and temporary test roots were removed. No commit/push.

Reproduce the live upload and encrypted config restoration proof:

```sh
docker build --target neko-backup -t openneko-pack-backup-test .
OPENNEKO_PACK_CONNECTOR_TEST=1 pnpm --filter @neko/worker test -- test/pack-connector.integration.test.ts
```

Evidence logs: `/tmp/issue290-step4-live.log`,
`/tmp/issue290-step4-lifecycle.log`, `/tmp/issue290-step4-packs.log`,
`/tmp/issue290-archive.log`, `/tmp/issue290-step4-regression.log`,
`/tmp/issue290-step4-other-regression.log`,
`/tmp/issue290-step4-typecheck.log`, and
`/tmp/issue290-step4-packs-typecheck.log`.

## Step 5 complete — 2026-09-08

### UI reuse map

The existing Packs surface was inspected at 1280px before editing
(`/tmp/issue290-packs-before.png`). Changes stay within Admin → Settings → Packs;
the existing Magento controls and shared navigation remain in use.

| Surface need | Existing component / style | Verification |
| --- | --- | --- |
| Page orientation | `AppHeader`, `SectionNav`, `PageHeading` | Rendered before/after at 1280px and 390px; Magento visual contract passed |
| Upload and manifest configuration | `Field`, `Input`, `NativeSelect`, `Checkbox` | Live ZIP/configuration flow, visible focus, required fields, and 44px phone targets passed |
| Review and installation | `Button`, `ActionGroup`, `Disclosure` | Live request disabled controls; editing invalidates approval; wrong credentials fail visibly and recover |
| Catalog and installation state | `Card`, `EmptyState`, `Pill`, `LocalDateTime` | Loading/empty screenshots plus real installed state and configuration after reload passed |
| Remove pack and feedback | `confirmDialog`, existing Toaster | Removal cancellation keeps installation active and returns focus; error details stay behind Disclosure |

No shared chrome or primitive changed. No bespoke controls or new palette/type
system was added. This map is ready for an eventual PR; no commit or PR was made.

### Delivered path

- `POST /api/admin/packs/upload` accepts raw `application/zip` behind the existing
  admin gate. Both web and worker enforce the 16 MiB limit while reading bytes,
  including bodies without Content-Length. The web supplies the authenticated
  uploader identity; clients cannot substitute it.
- The internal worker control plane exposes upload and review through the same
  `PackService` instance. Inspection/planning can select a version. Public review
  and apply use the same server-owned actor, exact configuration and approval.
- `openneko pack upload <archive.zip>` uploads a host file or `-` for stdin.
  Packaged installations stream host bytes to the selected worker through the
  existing Docker resolver; a host path is never interpreted inside the container.
- `pack review`, `install`, `configure`, and `upgrade` support `--input`,
  `--secret-ref`, `--source-id`, `--bind`, `--version`, and `--review-hash`.
  `--yes` displays and approves a fresh review. Otherwise an interactive prompt or
  an explicit review hash is required before applying a custom pack. Declared
  integer, boolean and enum values preserve their types. Original Magento flags
  remain available; mixing them with generic reviewed configuration is rejected
  instead of silently discarding flags.
- Admin Packs includes ZIP upload, catalog selection, declared configuration and
  credentials, source selection/bindings, review, installation, configuration,
  updates, status, and confirmed removal. Editing a value invalidates approval;
  credentials clear after apply. Existing Magento management remains on the page.

Example using an uploaded `service-health` pack and a stored credential:

```sh
openneko pack upload ./service-health.zip
openneko secrets set pack.service-health SERVICE_API_TOKEN
openneko pack install service-health \
  --input service.base_url=https://provider.example.com \
  --secret-ref service.api_token=SERVICE_API_TOKEN \
  --source-id YOUR_DATA_SOURCE_ID --yes
```

The existing secret-store command prompts without displaying the value. It does
not install a plugin. For separate review/approval, run `pack review` with the
same configuration, then pass its `reviewHash` to install with `--review-hash`
and its exact version with `--version`.

### Verification and UI review

- Worker admin HTTP suite: **51 tests passed**, including ZIP transport, the
  byte limit, and review dispatch. Web admin packs suite: **12 tests passed**,
  including admin denial, uploader/actor substitution rejection, bounded bodies,
  and exact review forwarding. Go pack/proxy command tests passed, including
  typed inputs, refusal without approval, host-file streaming, and Magento
  command compatibility.
- The live integration built the current Go CLI, uploaded and installed the
  custom pack through the real worker HTTP API, verified authenticated reads,
  and uninstalled it. The browser then uploaded that ZIP through the real Next
  API, rejected an invalid ZIP and a wrong credential, invalidated an edited
  review, installed successfully, and recovered installed configuration after
  reload. The CLI subsequently reconfigured and uninstalled it. No pack API,
  PackService, connector transport, or provider response was mocked.
- The custom flow ran in supported solo/admin mode against disposable PostgreSQL
  and the packaged GraphJin 3.20.47 image. Magento's adjacent UI used its existing
  visual fixture; the scheduler/workspace substitutions remain those documented
  for the connector suite. This is not a live Magento provider acceptance claim.
- `CustomPacksAdmin.tsx`: shared controls, primary-action hierarchy, labels,
  keyboard focus, cancelled-removal focus return, loading, empty, installed,
  validation-error, failed-install, disabled, and 390px/1280px layouts passed.
  Phone controls are at least 44px and the review form has no horizontal overflow.
  Raw diagnostics and artifact details are behind `Disclosure`.
- `MagentoPackAdmin.tsx`: the existing desktop/phone design-system contract
  passed, including typography, checkbox dimensions, activity copy, and overflow.
  Two visual baselines were updated for the new custom-pack panel and then passed
  a normal comparison run. The loading/empty-state visual test also passed.
- Families reviewed: Admin → Settings → Packs, including its Magento region.
  Data settings supplies the unchanged source-list API; that sibling page was
  not opened. Shared chrome was not changed, so no additional Briefing, Ask,
  Apps, or Sign-in visual claim is made.
- Web lint, web/worker typechecks, `pnpm ui:check`, and `git diff --check` passed.
  Temporary test containers and web servers were stopped. Unrelated `prototypes/`
  and the failed worktree remain untouched. Changes are uncommitted.

Reproduce the live CLI and Admin proof (dependencies and the packaged GraphJin
image must be available):

```sh
OPENNEKO_PACK_CONNECTOR_TEST=1 OPENNEKO_PACK_UI_TEST=1 \
  pnpm --filter @neko/worker test -- test/pack-connector.integration.test.ts -t 'real web API'
pnpm --filter web exec playwright test --config=playwright.design-system.config.ts
```

Evidence: `/tmp/issue290-step5-live.log`, `/tmp/issue290-step5-worker-api.log`,
`/tmp/issue290-step5-web-api.log`, `/tmp/issue290-step5-cli.log`,
`/tmp/issue290-step5-visual.log`, and the corresponding lint/typecheck logs.
Reviewed screenshots are preserved in `/tmp/issue290-step5-ui/` and
`/tmp/issue290-step5-visual/`; the Magento comparison baselines are checked-in
paths under `apps/web/test/visual/__screenshots__/`.

Step 6 remains pending: final acceptance and diff review for the agreed scope.
