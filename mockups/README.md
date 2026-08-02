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
(see §1.1), and M1 ships a registry fixture that renders to match it (§7,
§8). It shows the **target state**, not the cold start: generation plus a
few approval-gated `app_layout_update` tweaks (column choice/order, pill
emphasis) — the same conversational tuning any operator would do, and the
demo of the agent improving its own app's UI.

---

## 1. Ground rules

### 1.1 Every mockup region is generatable — the three buckets

Feasibility check, region by region (details in the §2 map): everything on
this screen falls into one of three buckets, and nothing falls outside them.

1. **Pure registry data** — the rail group (labels, counts, `__c` badges),
   every table column and cell treatment (`record_field.kind` → renderer),
   pill values/colors (`picklist_values` + stable-hash palette), filters
   (registry fields × the GraphJin operator set), record counts (`count_id`
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

## 2. Mockup → component map

| Mockup region | Component (new unless noted) | Data source |
|---|---|---|
| CRM group in app rail (objects, counts, `__c` badges) | `AppNavGroup` inside existing `AppRail` | `record_app` + `record_object` (incl. `record_count`), gated on `app_state.status='active'` |
| Breadcrumb + record count + search | `ObjectHeader` | registry + list-count query |
| "New opportunity" / "Import" buttons | `ObjectHeaderActions` | `record_permission` (hide create without grant); Import → `records_import_*` surface (admin only) |
| Saved-view picker + filter chips | `ViewBar` (`ViewPicker`, `FilterChip`, `AddFilterPopover`) | Phase 1: URL-state filters over registry fields · Phase 3: persisted saved views |
| "My records" toggle | `ScopeToggle` in `ViewBar` | adds `owner_user_id: {eq: $viewer}` to the list query — display-side narrowing *on top of* GraphJin row policy, never instead of it |
| Record table (columns, sort, pagination) | `RecordTable` + per-kind cell renderers | generated GraphQL list query; columns from list layout (`record_layout kind='list'`) |
| Stage pill | `PicklistPill` (cell renderer for `kind='picklist'`) | picklist values from `record_field.picklist_values`; color assignment by stable hash into the semantic pill palette, overridable in registry |
| Amount / dates | `NumberCell` / `DateCell` with `tabular-nums` | field `kind` + `scale` |
| Owner cell with dashed "unlinked" avatar + flag | `OwnerCell` | join through `engine.identity_map`; `status='unlinked'` renders the dashed avatar + watch flag |
| "1 pending change" chip + row accent stripe | `PendingChangeMarker` | open `action_request` rows of kind `record_*` whose payload `id` intersects the current page (small metadata-DB lookup keyed by the page's record ids) |
| Status strip (migration, delta sync, backup, identity) | `SubstrateStrip` (app-level, shared across objects) | `app_state.config` (import provenance), sync watermark, backup-verification finding (C13), `identity_map` unlinked count |
| Ask panel (scope chip, thread, composer) | `AskPanel` — **reuse** the existing work-thread machinery (`_work.css`, `_composer.css`, thread APIs) with a scope preamble | new thread context type `{app, object, viewFilters, recordId?}` injected as a context block on thread create |
| Approval card with field diff + freshness note | `RecordActCard` — **extend** the existing action approval card (`_act-card.css`, approvals flow) with a `record_update` diff body | `action_request.payload` (fields, `expected`) rendered as from→to rows |
| Auto-fired rule line | existing action timeline row style | `action_request` resolved with mode `auto` |

## 3. Routes & API

```
apps/web/src/app/a/[app]/
  layout.tsx                     app gate (app_state) + AppNavGroup wiring
  page.tsx                       app home (Phase 3; until then redirect → first object)
  [object]/page.tsx              list view (this mockup)
  [object]/[id]/page.tsx         record detail (layout sections, related lists, change log)
  [object]/new/page.tsx          create form        (Phase 3)
  [object]/[id]/edit/page.tsx    edit form          (Phase 3)
  admin/…                        import report, identity, permissions, schema history (Phase 3)

apps/web/src/app/api/a/
  [app]/nav/route.ts             objects + counts for the rail group
  [app]/[object]/list/route.ts       generated list query → GraphJin (viewer JWT)
  [app]/[object]/[id]/route.ts       detail + related lists + change-log page
  [app]/status/route.ts          SubstrateStrip payload
  [app]/[object]/submit/route.ts     form submits → pre-approved action request (Phase 3)
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
and (Phase 3) form inputs — three views of the same registry row:

| kind | list cell | detail | form input (Phase 3) |
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

**M1 (Phase 1 — read-only):** `AppNavGroup`, app gate/layout, list view
(`ObjectHeader`, `ViewBar` with URL-state filters, `RecordTable` + renderer
matrix minus form column), detail page (sections, related lists, change-log
timeline), `SubstrateStrip`, `OwnerCell` identity states.
*Done when:* every imported object browses correctly with zero
object-specific code; member vs admin row visibility verified in e2e; **the
mockup-parity test passes** — the `mockup-crm` fixture (below) renders the
opportunity list view to a visual-regression match of
`crm-main-screen.html`.

**The mockup-parity fixture:** the mockup re-expressed as registry content —
the CRM blueprint (objects, fields, picklists) + the exact list layout shown
(columns, order, pill emphasis, stored as `record_layout` rows, as if applied
by `app_layout_update`) + seeded records including the mockup's specific
states (an unlinked SF owner, a pending `record_update` on the Meridian row)
+ an `app_state.config` matching the substrate strip. If any pixel of the
mockup cannot be produced from this fixture through the generated pipeline,
that is a registry/renderer feature gap to fix — never a hardcoded special
case. The fixture doubles as the seeded demo app.

**M2 (Phase 2 — chat writes):** `AskPanel` scoping, `RecordActCard` diff
body, `PendingChangeMarker`, auto-fired rule rows.
*Done when:* the mockup's Meridian scenario (update needs approval, activity
auto-logs, row flags pending, approval clears it) passes as an e2e script.

**M3 (Phase 3 — forms & admin):** create/edit forms from the renderer matrix,
submit-as-pre-approved-action route, saved views (persisted per user/org),
admin pages (import report, identity mapping, permissions editor).
*Done when:* per-kind form round-trip e2e green; a `deny` policy blocks the
form path; saved views survive reload and are shareable org-wide by admins.

## 8. Testing

- **Renderer matrix unit tests:** one fixture registry row per kind → cell,
  detail, and form snapshots.
- **Query-generation tests:** registry fixture → expected GraphQL documents
  (columns, filters, pagination, ordering), including injection resistance on
  filter values (variables only, never string-built).
- **e2e (`apps/web/test/` conventions):** seeded mini-registry + records;
  nav gating (app inactive → 404, active → rail group), list filtering +
  sort + pagination, detail related lists, M2 scenario above, RBAC
  visibility split, unlinked-owner rendering.
- **Mockup-parity visual regression (the M1 acceptance test):** seed the
  `mockup-crm` fixture (§7), render `/a/crm/opportunity` through the real
  generated pipeline (registry → generated GraphQL → renderers), and
  screenshot-compare against `crm-main-screen.html` — rail group, table
  treatment, pill palette, pending-row stripe, owner identity states, and
  substrate strip all within tolerance. A parity failure is a
  registry/renderer gap, not a test to relax.
