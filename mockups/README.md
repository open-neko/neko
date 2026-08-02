# CRM App UI — Mockup & Implementation Plan

**Mockup:** [`crm-main-screen.html`](crm-main-screen.html) — open directly in a
browser; fully self-contained. It shows `/a/crm/opportunity` (an app's list
view — here the CRM app) with the three zones this plan implements:
registry-driven object rail, the working list view with substrate status strip,
and the scoped Ask panel with an approval card.

This plan details **component C6 (auto-generated web UI)** of
[RECORDS_ENGINE.md](../RECORDS_ENGINE.md) to implementation level. Everything
here assumes C1–C5 (records-db, registry, app builder, record write path,
GraphJin/JWT). The UI is generated per app from registry metadata — the CRM
shown here is one app; a support-desk app renders through the exact same
components.

**The mockup is not an illustration — it is the acceptance criterion.** It
depicts what the *generated* UI must produce from registry content alone
(see §1.1). M1 proves the generated-content region and a second non-CRM
fixture; M2 proves the complete Ask/approval/pending scenario against this
screen (§7, §8). It shows the **target state**, not the cold start: generation
plus a few approval-gated `app_layout_update` tweaks (column choice/order,
pill emphasis) — the same conversational tuning any operator would do, and
the demo of the agent improving its own app's UI.

The finished grid is only half the product claim. Before M1 implementation,
the design set also covers the new OpenNeko journey: conversation → draft app
→ high-level schema review (no SQL) → approval → CSV/source mapping → provisioning → mirror
health → cutover. Those states are native trust/creation surfaces, not registry
pages, and prevent a familiar CRM shell from underselling the reinvention.

---

## 1. Ground rules

### 1.1 Every mockup region is generatable — the three buckets

Feasibility check, region by region (details in the §2 map): everything on
this screen falls into one of three buckets, and nothing falls outside them.

1. **Pure registry data** — the rail group (labels, counts, `__c` badges),
   every table column and cell treatment (`record_field.kind` → renderer),
   pill values/colors (`picklist_values[].color/emphasis`, with stable-hash
   fallback), filters (a typed semantic AST over registry fields, including
   relative-date macros and `picklist_values[].semantic` groups such as
   open/closed), record counts (`count_id`
   aggregate), the "My records" toggle (registry-known ownership column).
   Zero app-specific code, by construction.
2. **Generic mechanisms with registry inputs** (built once, app-agnostic):
   the owner cell's unlinked-identity state (join through
   `engine.identity_map`), the pending-change stripe (metadata-DB
   `action_request` rows intersected with the page's record ids —
   cross-DB merge in the list API), and the `SubstrateStrip`
   (`app_state.config` + watermark + backup finding + unlinked count).
3. **Native trust surfaces composed in** — the Ask panel and its approval
   card are deliberately *not* generated (D15/D16 boundary): native thread
   machinery mounted in the third column with a scope context.

The known gap is **default quality, not feasibility**: cold-start layout
heuristics render correctly but plainer than this mockup. The distance is
closed by layout metadata, not code — which is exactly what the parity
fixture (§8) exercises.

- **The mockup is built from the app's real tokens** (`globals.css` `@theme`:
  `--color-bg #FAFAF7`, `--color-accent #6B5CE7`, Archivo display / Manrope
  body, `--radius-card 20px`, the soft shadows). Implementation uses those
  tokens directly — no new palette, no new radii. New styles land as
  `apps/web/src/app/styles/_records.css`, following the underscore-partial
  convention, imported from `globals.css`.
- **Nothing renders from a hardcoded schema.** Every label, column, pill,
  count, and form field is derived from `engine.record_*` registry rows via
  `@neko/records` (the C2 accessor package). If a component needs a
  per-object special case, that's a registry feature request, not an `if`.
- **Reads go through GraphJin with the viewer's JWT** (D5). No SQL in web.
- **Writes go through the action stack** (D6). The Ask panel proposes;
  forms submit pre-approved action requests. One executor, one change log.
- **CRM is a fidelity fixture, not the universal information architecture.**
  Large imports use an app switcher, favorite/recent objects, object search,
  and collapsed groups instead of putting hundreds of objects in one rail.
- **Outages are loud.** `SubstrateStrip` is quiet healthy/background status;
  an unreachable records database/data plane renders a prominent native
  degraded banner with a path to health details.

## 2. Mockup → component map

| Mockup region | Component (new unless noted) | Data source |
|---|---|---|
| CRM group in app rail (objects, counts, `__c` badges) | `AppNavGroup` inside existing `AppRail` | `record_app` + `record_object` (incl. `record_count`), gated on `app_state.status='active'` |
| Breadcrumb + record count + search | `ObjectHeader` | registry + list-count query |
| "New opportunity" / "Import" buttons | `ObjectHeaderActions` | `record_permission` (hide create without grant); Import → `records_import_*` surface (admin only) |
| Saved-view picker + filter chips | `ViewBar` (`ViewPicker`, `FilterChip`, `AddFilterPopover`) | Phase 1: URL-state filters over registry fields · Phase 3: persisted saved views |
| "My records" toggle | `ScopeToggle` in `ViewBar` | adds `owner_user_id: {eq: $viewer}` to the list query — display-side narrowing *on top of* GraphJin row policy, never instead of it. It is **off** in the golden screen because an unlinked source owner is intentionally visible. |
| Record table (columns, sort, pagination) | `RecordTable` + per-kind cell renderers | generated GraphQL list query; columns from list layout (`record_layout kind='list'`) |
| Stage pill | `PicklistPill` (cell renderer for `kind='picklist'`) | picklist values from `record_field.picklist_values`; color assignment by stable hash into the semantic pill palette, overridable in registry |
| Amount / dates | `NumberCell` / `DateCell` with `tabular-nums` | field `kind` + `scale` |
| Owner cell with dashed "unlinked" avatar + flag | `OwnerCell` | join through `engine.identity_map`; `status='unlinked'` renders the dashed avatar + watch flag |
| "1 pending change" chip + row accent stripe | `PendingChangeMarker` | open `action_request` rows of kind `record_*` whose payload `id` intersects the current page (small metadata-DB lookup keyed by the page's record ids) |
| Status strip (migration, delta sync, backup, identity) | `SubstrateStrip` (app-level, shared across objects) | `app_state.config` (import provenance), sync watermark, backup-verification finding (C13), `identity_map` unlinked count |
| Ask panel (scope chip, thread, composer) | `AskPanel` — **reuse** the existing work-thread machinery (`_work.css`, `_composer.css`, thread APIs) with a scope preamble | new thread context type `{app, object, viewFilters, recordId?}` injected as a context block on thread create |
| Approval card with field diff + freshness note | `RecordActCard` — **extend** the existing action approval card (`_act-card.css`, approvals flow) with a `record_update` diff body | `action_request.payload` (fields, `expected`) rendered as from→to rows |
| Auto-fired rule line | existing action timeline row style | `action_request` resolved with mode `auto` |

`ViewBar` never stores raw GraphQL. Its semantic filter AST supports ordinary
field operators plus reviewed macros such as `this_quarter`, `last_n_days`, and
picklist groups such as `is_open`; query generation validates them against the
registry and binds leaf values as variables.

## 3. Routes & API

```
apps/web/src/app/a/[app]/
  layout.tsx                     app gate (app_state) + AppNavGroup wiring
  page.tsx                       app home (Phase 3; until then redirect → first object)
  [object]/page.tsx              list view (this mockup)
  [object]/[id]/page.tsx         record detail (layout sections, related lists, change log)
  [object]/new/page.tsx          minimal create drawer Phase 1; full form Phase 3
  [object]/[id]/edit/page.tsx    minimal edit drawer Phase 1; full form Phase 3
  admin/…                        import report, identity, permissions, schema history (Phase 3)

apps/web/src/app/api/a/
  [app]/nav/route.ts             objects + counts for the rail group
  [app]/[object]/list/route.ts       generated list query → GraphJin (viewer JWT)
  [app]/[object]/[id]/route.ts       detail + related lists + change-log page
  [app]/status/route.ts          SubstrateStrip payload
  [app]/[object]/submit/route.ts     minimal Phase 1 + full Phase 3 forms → pre-approved action request
```

API routes mint the viewer's GraphJin token per request via the C5 helper
(`mintGraphjinToken` with session `userId`/`role`), build the GraphQL document
from the registry (selected columns, filter args, `order_by`, cursor
pagination — `first/after`, default 50), and stream results through. The list
route returns `{rows, cursor, total}` where `total` is the filtered count used
by the header and pagination.

**Server components by default;** client components only where interaction
demands it (`ViewBar`, `RecordTable` sort/selection, `AskPanel`). List pages
render on the server with the first page inlined.

## 4. Cell/field renderer matrix

One renderer per `record_field.kind`, used by table cells, detail sections,
and form inputs. Phase 1 ships the common-field subset needed by the vertical
slice; Phase 3 completes the matrix:

| kind | list cell | detail | form input (complete in Phase 3) |
|---|---|---|---|
| text / email / phone / url | truncated text (link-ified where kind implies) | full text | text input w/ kind validation |
| textarea | first line, muted | paragraph | textarea |
| boolean | ✓ / — | ✓ / — | checkbox |
| integer / decimal / currency / percent | right-aligned tabular-nums, currency/percent formatted | same | numeric input, `scale`-aware |
| date / datetime | `DateCell` (relative within 7d, absolute beyond) | absolute + relative | date/datetime picker |
| picklist | `PicklistPill` | pill | select from `picklist_values` (active only) |
| multipicklist | up to 2 pills + `+n` | pill row | multi-select |
| reference | target record's `name_field` as link | link + hover mini-card (Phase 3) | typeahead lookup querying target object |
| readonly_formula / legacy audit | plain value, muted | value + "read-only" affordance | rendered, disabled |
| id | never shown in lists | copyable, muted, monospace | — |

## 5. Ask panel integration

- The panel is the existing Ask/work thread UI mounted in a third column
  (`grid-template-columns: 216px minmax(0,1fr) 332px`; collapses behind a
  toggle below the `--d-dash-width` breakpoint — reuse the responsive
  patterns in `_responsive.css` / `_dock.css`).
- On mount it registers a **scope context**: app, object, active view
  filters, and — on detail pages — the record id. The worker's thread-create
  path injects this as a context block so the agent's first GraphJin queries
  are already narrowed. Scope is advisory context, not a security boundary
  (the JWT is the boundary).
- Approval cards render inline in the thread exactly as in `/work`; the
  `RecordActCard` variant adds the field-diff body and the freshness line
  (from the adapter's `expected`-check result). Approving resumes the run;
  the list view's `PendingChangeMarker` clears on the action-request status
  change (poll piggybacked on the existing approvals polling).

## 6. Styling notes (from the mockup)

- `_records.css` additions only: rail group label reuses `.rail-label`
  conventions; pills use the existing semantic soft/ink pairs; the pending-row
  treatment is the accent-soft gradient + 3px inset stripe as mocked; the
  status strip is a quiet `--radius-inner` card, Archivo micro-labels.
- Density: respect `[data-density]` — table row padding and viewbar gaps get
  compact/comfortable values like `_dashboard.css` does.
- Accessibility: `aria-current` on the active object, `role="switch"` on
  scope toggle, focus-visible outlines (already tokenized), row actions
  keyboard-reachable; pills always pair color with text (never color-only).

## 7. Milestones

**M0 (before Phase 1 implementation — creation/trust journey):** design the
conversation, draft app, schema preview, approval, import/source mapping,
provisioning, mirror health, and cutover states. *Done when:* every long-running
or destructive-looking transition exposes exact intent, current phase,
recovery/retry behavior, and what remains under the source system's control.

**M1 (Phase 1 — generated content and minimum usability):** `AppNavGroup`, app
gate/layout, list view (`ObjectHeader`, semantic `ViewBar`, `RecordTable` +
renderer matrix), detail page, minimal create/edit drawer, `SubstrateStrip`,
and `OwnerCell` identity states. The visual contract crops to the rail + main
generated-content region; it does not claim the M2 Ask/pending scenario exists
yet. *Done when:* every fixture object browses correctly with zero
object-specific code; member/admin visibility is verified; the `mockup-crm`
generated-content crop matches; and the adversarial `mockup-operations`
fixture renders long labels, many fields, nulls, no ownership, unknown
picklists, and permission-hidden fields without special cases. Adding a field
or changing layout data must change the UI without a deploy.

**The parity fixtures:** `mockup-crm` re-expresses the CRM blueprint, fields,
picklist color/emphasis, exact list layout, semantic filters, seeded owners,
and substrate state as registry/engine data. `mockup-operations` is deliberately
non-CRM and awkward. At M2, CRM additionally seeds the pending Meridian action
and native scoped thread. If a region cannot be produced through the generic
pipeline, that is a registry/renderer gap to fix—never a hardcoded special
case. Both fixtures double as demos.

**M2 (Phase 3 — complete target-screen scenario):** `AskPanel` scoping,
`RecordActCard` diff body, `PendingChangeMarker`, and auto-fired rule rows.
*Done when:* the full `crm-main-screen.html` visual match and Meridian behavior
pass together: update needs approval, activity auto-logs, row flags pending,
approval clears it, and the unlinked owner remains visible because “My records”
is off.

**M3 (Phase 3 — full forms & admin):** complete form matrix,
submit-as-pre-approved-action route, semantic saved views persisted per
user/org, and admin pages (import report, identity, permissions, history).
*Done when:* per-kind form round-trip e2e is green; a deny policy blocks the
form path; saved views survive reload and admins can share them org-wide.

## 8. Testing

- **Renderer matrix unit tests:** one fixture registry row per kind → cell,
  detail, and form snapshots.
- **Query-generation tests:** registry fixture → expected GraphQL documents
  (columns, filters, pagination, ordering), including injection resistance on
  filter values (variables only, never string-built), relative-date macros,
  open/closed picklist groups, and deleted-row exclusion.
- **e2e (`apps/web/test/` conventions):** seeded mini-registry + records;
  nav gating (app inactive → 404, active → rail group), list filtering +
  sort + pagination, detail related lists, M2 scenario above, RBAC
  visibility split, unlinked-owner rendering.
- **Mockup-parity visual regressions:** M1 compares the generated-content crop
  and runs the non-CRM fixture; M2 compares the complete CRM screen including
  pending stripe and native Ask panel. Pin browser version, viewport, DPR,
  fonts, timezone, clock, locale, reduced-motion, seeded ids/counts, and
  animation completion. A parity failure is a registry/renderer gap, not a
  reason to relax the test.
