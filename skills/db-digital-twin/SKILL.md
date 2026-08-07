---
name: db-digital-twin
description: Generate an interactive 3D "sim-city" digital twin of a business from any database — a single self-contained HTML file with a daylight, Cities-Skylines-style world where entities become districts and buildings, transactions become vehicles moving on roads, and operational alerts become in-world findings with drafted actions. Use this whenever the user wants to visualize a database, schema, or company as a 3D world, city, simulation, "digital twin", or "sim city" — or asks for an interactive/visual/spatial overview of their business data, operations dashboard as a game, or "watch my orders flow". Works from a live database connection, a SQL/DDL schema dump, a SQLite file, CSVs, or even a written description of the data. When a running GraphQL endpoint (e.g. GraphJin) is available, it can also wire the twin live — polling on an interval so heights, KPIs, and findings track the database in real time; use it for "live view of my data as a city/simulation" requests too.
---

# Database → Digital Twin

Turn a database into an explorable 3D company-city. The output is **one
self-contained HTML file** (~2 MB): Babylon.js is pre-bundled in this skill's
assets, so no network access, CDN, or build step is needed at view time — it
works under strict CSP (including Claude Artifacts) and offline.

The core idea the output must honor: **every object on screen is a real query.**
Buildings are sized by real aggregates, vehicles replay real transaction flow,
findings come from real thresholds — and clicking any object shows the query
that produced it. Nothing is decorative fiction; it is the database, projected.

## Workflow

### 1. Get the data

Use whatever the user has, in order of preference:
- **Live connection** (psql/mysql/sqlite CLI, GraphJin endpoint): introspect
  tables, then run a handful of aggregates (counts, sums by group, min/max
  dates, threshold breaches).
- **Schema dump / DDL text**: read the tables and columns; if row counts or
  metrics are provided use them, otherwise derive plausible magnitudes from
  the user's description and *say so* in your summary.
- **SQLite/CSV files**: query them directly (python3 + sqlite3/csv is always
  available).

You need surprisingly little: entity names, one magnitude per entity (revenue,
count, stock level), and one or two time/status columns to derive findings.

### 2. Classify entities into the world model

Read `references/world-spec.md` (short) for the spec and the classification
table. In brief: organizational/revenue dimensions → back-band tower
districts; operational pipeline (stages, inventory, fulfillment, external
gateways) → front-band row in flow order; transactions → vehicle flows from
originator to completer; threshold/SLA breaches in the data → findings.

Every schema has a story — a thing that enters, moves, and completes. Find it
before writing JSON: "orders flow from territories to the shipping dock",
"tickets flow from accounts to resolution". One primary flow (spawning every
~0.8s, wired to a KPI via `countKpi`) plus one or two secondary flows is the
sweet spot.

### 3. Write the world spec

Write `world.json` following the spec. Quality bar learned from iteration:

- **Real names everywhere** — building names, stats, and `query` fields use
  the actual table/column names from the schema. The inspector query is the
  proof that the twin is a projection, not an illustration.
- **Normalize sizes per district** (biggest ≈ 0.9) so differences read.
- **2–5 findings**, each derived from the data (stale rows, below-threshold
  stock, negative deltas, spikes). Give SLA-type findings a `cluster` so the
  stuck items are visibly parked at the building. Write `action` as a
  concrete drafted next step, not a description of the problem.
- **KPIs**: 3–4 chips; put the alarming ones in `amber`/`red` tone.

### 4. Build

```bash
python3 <skill-path>/scripts/build.py world.json twin.html          # artifact fragment
python3 <skill-path>/scripts/build.py world.json twin.html --page   # standalone page
```

The script validates the spec (unknown finding targets, duplicate ids, empty
districts) and fails with a readable list if something's wrong — fix and
rerun. Use `--page` whenever the file will be opened from disk or served
over HTTP (it adds the doctype and UTF-8 charset wrapper; without it,
browsers mis-decode the bare fragment). The default bare fragment is only
for publishing as a Claude Artifact.

### 4b. Live mode — when there's a queryable endpoint

If the data source is a *running* GraphQL endpoint (GraphJin, Hasura-style)
rather than a dump, offer the live twin: add a `WORLD.live` block (endpoint,
poll interval, query bindings) and the page becomes a synchronized twin —
heights, stats, and KPIs re-poll on an interval, and findings with their
rings, badges, and stuck-vehicle clusters appear and dissolve as thresholds
breach and clear in the data. The binding vocabulary is in
`references/world-spec.md` (Live mode section) and a complete working spec is
`examples/adventureworks-live.json`.

Live constraints to respect:
- The endpoint must allow CORS from the page's origin, and the page must be
  served (`--page` build + any static server) — a live twin cannot be a
  CSP-locked artifact, since it fetches at runtime.
- Write findings as *thresholds over queries* (min/below), not as baked
  facts, so the world reflects the database rather than the build moment.
- The best verification is causal: change the data (insert or age rows —
  openneko's demo stack ships scenario SQL for exactly this) and confirm the
  twin reacts within one poll without a reload.

### 5. Verify before delivering

If headless Chromium is available (`/opt/pw-browsers/chromium` or similar),
render and screenshot; look at the screenshot yourself:

```bash
chromium --headless --no-sandbox --enable-unsafe-swiftshader \
  --window-size=1440,900 --virtual-time-budget=5000 \
  --screenshot=check.png twin.html
```

Wrap the file in `<!doctype html><html>…</html>` first if rendering the bare
fragment misbehaves. Check: buildings present in both bands, labels legible,
no overlapping districts, vehicles on roads. A page that renders only the HUD
with an empty sky means a JS error — capture console output (playwright-core
if available) rather than guessing.

### 6. Deliver

- Static twin in a session with the Artifact tool: publish the default
  (fragment) build — it is CSP-safe by construction and already omits the
  doctype/html wrapper as Artifacts require.
- Static twin otherwise: hand over a `--page` build and mention it opens
  locally with no server, and that drag orbits / scroll zooms / clicking
  inspects.
- Live twin: serve a `--page` build over HTTP (e.g. `python3 -m http.server`)
  and point the user at the URL; note the LIVE/OFFLINE chip and the poll
  interval.

In your summary, tell the user which entities became what (two or three
sentences), and flag any numbers that are estimates rather than queried facts.

## Judgment calls

- **Too many entities**: cap districts at ~12 buildings (top N by magnitude,
  fold the tail into an "Other" building). A readable city beats a complete one.
- **No obvious flow** (pure reference/config schema): still build the
  districts and findings; set one slow ambient flow so the world breathes, and
  say the flow is illustrative.
- **User's own art direction wins**: the daylight look is the default, not a
  rule. If they ask for night mode or brand colors, adjust `color` fields and
  note that deeper theme changes mean editing `assets/template.html` CSS.
- The engine and template are assets, not black boxes — for requests beyond
  the spec (new building kinds, different layouts), edit copies of
  `assets/engine.js`/`template.html` rather than fighting the spec.
