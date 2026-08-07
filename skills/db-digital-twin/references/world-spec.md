# World spec reference

The world spec is a single JSON file consumed by `scripts/build.py`. It describes
the business as districts of buildings, flows between them, and findings. The
engine handles all layout, rendering, camera, lighting, and interaction — you
only describe *what exists and what it means*.

## Top level

```json
{
  "title": "Acme Roasters",
  "eyebrow": "Digital Twin",
  "note": "Optional HTML for the header card. Defaults to a 'pure projection' explainer.",
  "clock": {"dayLabel": "TUE", "start": "09:00", "loopStart": "08:00", "loopEnd": "18:00", "speed": 60},
  "kpis": [ {"label": "Orders today", "value": "187", "tone": ""},
            {"label": "Pending > SLA", "value": "8", "tone": "amber"} ],
  "legend": [ {"label": "orders", "color": "#2F6FED"} ],
  "districts": [ ... ],
  "flows": [ ... ],
  "findings": [ ... ]
}
```

- `clock` is optional (defaults shown). The sun rises/sets across the loop
  window, then the replay loops — the scene never goes dark.
- `kpis`: up to 4 chips in the top bar. `tone` is `""`, `"amber"`, or `"red"`.
- `legend`: what the moving vehicles mean. Match colors to your flows.

## Districts

A district is a named group of buildings. Two bands:

- `"band": "back"` — a plaza of towers in the background. Use for the
  *organizational/revenue* dimension: sales territories, regions, teams,
  customer segments, product lines-as-business-units. Buildings are laid out
  in a grid (`cols` optional, default 5).
- `"band": "front"` — a row along the industrial yard in the foreground. Use
  for the *operational pipeline*: process stages, inventory, fulfillment,
  external gateways. Buildings are laid out left-to-right in array order, so
  order them as the real flow runs (suppliers → process → stock → shipping).

```json
{"id": "sales", "label": "SALES TERRITORIES", "band": "back", "cols": 5,
 "buildings": [
   {"id": "t-germany", "name": "Germany", "label": "Germany",
    "kind": "tower", "size": 0.36, "weight": 3.8,
    "kindLabel": "Sales territory",
    "stats": [["Sales YTD", "$3.8M"], ["WoW", ["−31%", "red"]]],
    "query": "SELECT ... the real query that produced these numbers"}
 ]}
```

Building fields:
- `kind`: `tower` (offices/orgs), `block` (factory/process stage), `tank`
  (inventory/stock silo), `flat` (dock/warehouse/fulfillment), `gate`
  (external boundary: vendors, partners, API). Back band should be towers;
  front band any of the rest.
- `size`: 0..1, drives height. **Normalize within each district** — divide by
  the district max so the biggest entity is ~0.9 and differences are visible.
- `weight`: relative spawn rate when a flow sources from this district
  (e.g. territory revenue). Defaults to 1.
- `stats`: pairs shown in the inspector. A value can be `["text", "red"]`
  (or `"amber"`/`"teal"`) to color it.
- `query`: the real SQL/GraphQL that produced this building's numbers. This is
  the heart of the concept — every object is a query. Show real table and
  column names from the actual schema.
- `color`: optional hex override; otherwise a pleasant palette is assigned.

## Flows

Vehicles that continuously travel between locations along the road network.

```json
{"kind": "van", "color": "#2F6FED", "every": 0.8,
 "from": "sales", "to": "dock", "countKpi": 0}
```

- `kind`: `van` (small, fast — transactions), `truck` (large — inbound goods),
  `cart` (tiny — internal movement).
- `every`: seconds between spawns. 0.6–1.0 for a busy primary flow, 4–8 for
  occasional deliveries.
- `from`: a district id (spawns from a weighted-random building), a building
  id, or `"offmap-left"` (arrives from outside).
- `to`: a building id, district id, or `"offmap-right"` (leaves the map).
- `countKpi`: optional index into `kpis` — increments that KPI per spawn,
  which makes the top bar feel live.

## Findings

Operational alerts, drawn as pulsing rings + map-pin badges on their target
building, listed in the findings rail, and shown in the inspector with an
Approve/Dismiss drafted action.

```json
{"id": "slowship", "severity": "amber", "target": "dock",
 "title": "8 orders pending > 5 days",
 "source": "Slow-Ship watcher · daily 07:00",
 "action": "Draft carrier follow-up and post the stuck list to #ops.",
 "cluster": 8}
```

- `severity`: `red` (breach), `amber` (warning), `info` (notable, positive spikes).
- `cluster`: optional — parks that many stalled vehicles next to the target,
  perfect for "N stuck orders" findings.
- Derive findings from the data itself: thresholds crossed (stock below
  reorder), staleness (rows pending > N days), deltas (revenue down
  week-over-week), spikes (demand ×3). 2–5 findings make the twin feel alive;
  fabricate none — each needs a real query behind it.

## Live mode (optional)

Add a `live` block and the page becomes a synchronized twin instead of a
snapshot: it re-runs bindings against a GraphQL endpoint on an interval and
patches the world in place — heights tween, stats and KPIs update, findings
(rings, badges, stuck-vehicle clusters) appear and dissolve as thresholds
breach and clear. A LIVE/OFFLINE chip reports sync health. See
`examples/adventureworks-live.json` for a complete working spec (pairs with
the repo's AdventureWorks demo stack).

```json
"live": {
  "endpoint": "http://localhost:8080/api/v1/graphql",
  "pollMs": 5000,
  "bindings": [ ... ]
}
```

Two binding shapes:

- **Row-matched** — one query updates a whole district. Each row maps to the
  building whose id is `matchPrefix + slug(row[rowKey])` (slug: lowercase,
  non-alphanumerics → `-`), so name building ids accordingly.
  ```json
  {"root": "salesterritory", "matchPrefix": "t-", "rowKey": "name",
   "query": "query { salesterritory { name salesytd } }",
   "size": {"field": "salesytd", "max": 11600000},
   "stat": {"label": "Sales YTD", "field": "salesytd", "format": "$M"},
   "weightField": "salesytd"}
  ```
- **Scalar** — first row, one field (aggregates like `count_x`/`sum_x` return
  a single row). Can update a building stat (`target` + `stat`), a KPI chip
  (`kpi` index + `format`), and drive a finding:
  ```json
  {"root": "salesorderheader", "field": "count_salesorderid",
   "query": "query { salesorderheader(where:{and:[{status:{eq:1}},{shipdate:{is_null:true}},{orderdate:{lt:\"{{daysAgo:5}}\"}}]}) { count_salesorderid } }",
   "target": "dock", "stat": {"label": "Breaching SLA", "format": "int"}, "kpi": 3,
   "finding": {"id": "slowship", "severity": "amber", "target": "dock",
     "titleTpl": "{n} orders pending > 5 days", "source": "Slow-Ship watcher · live",
     "action": "Draft carrier follow-up.", "cluster": true}}
  ```
  Finding thresholds: fires when value ≥ `min` (default 1), or with `below`
  set, when value < `below` (for stock-under-reorder shapes). `{n}` in
  `titleTpl` is the value; `cluster: true` parks that many stalled vehicles
  at the target. `{{daysAgo:N}}` anywhere in a query resolves to an ISO date
  at fetch time.

Formats: `$M`, `$k`, `int`. The endpoint must allow CORS from wherever the
page is served (GraphJin: `cors_allowed_origins: ['*']`) — which also means
a live twin is served over HTTP, not published as a CSP-locked artifact.

## Classification heuristics

| In the schema | In the twin |
|---|---|
| Regions, territories, segments, teams, stores | back-band towers, `size` = revenue/volume share |
| Pipeline stages, work centers, queues, statuses | front-band blocks in flow order |
| Inventory, stock, balances, capacity | front-band tanks, `size` = level vs capacity |
| Fulfillment, shipping, delivery, completion | front-band flat building (a natural flow target) |
| Vendors, suppliers, partners, external APIs | front-band gate at the left edge |
| Transactions (orders, tickets, payments, events) | flows: entity that *originates* → entity that *completes* |
| Thresholds, SLAs, anomalies in the data | findings |

Businesses without physical goods still map cleanly: a SaaS helpdesk is
accounts (towers) → ticket queues (blocks) → resolution (flat), with tickets
as vans and SLA breaches as findings. Invent the geography, never the numbers.
