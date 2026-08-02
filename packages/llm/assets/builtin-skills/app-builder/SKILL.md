---
name: app-builder
description: Design or evolve governed OpenNeko record apps from plain-language workflows, recurring hand-tracked lists, or spreadsheets. Use when an operator asks to create an app, tracker, CRM, support desk, inventory system, or custom business workflow; add objects or fields; change permissions or layouts; or turn a CSV into a new app.
---

# App Builder

Turn the operator's workflow into one complete, approval-ready records action.
Model novel domains directly; CRM and support blueprints are starting priors,
not limits.

## Build a new app

1. Infer the goal, entities, relationships, ownership boundary, member/admin
   permissions, useful list/detail layouts, and the smallest useful overview.
2. Ask at most one grouped clarification when the core workflow or who may see
   whose records would materially change the design. Otherwise state concise
   assumptions and proceed.
3. Propose the whole initial app through the installed `app_create` action in
   one card. Use `scope: internal`. Never write SQL or split initial fields into
   many approvals.
4. Explain what the proposal creates and any assumptions. Do not claim the app
   exists until the action reports successful execution.

The `app_create` payload must include:

```json
{
  "app": "permanent_snake_case_id",
  "label": "Human label",
  "purpose": "The workflow this app replaces",
  "objects": [
    {
      "api_name": "work_item",
      "label": "Work item",
      "plural_label": "Work items",
      "name_field": "subject",
      "visibility": "owner",
      "fields": [
        { "api_name": "subject", "label": "Subject", "kind": "text", "required": true },
        { "api_name": "status", "label": "Status", "kind": "picklist", "picklist_values": ["new", "active", "done"] }
      ],
      "layouts": [
        { "kind": "list", "definition": { "columns": ["subject", "status"] } },
        { "kind": "detail", "definition": { "sections": [{ "label": "Details", "fields": ["subject", "status"] }] } }
      ]
    }
  ],
  "permissions": [
    { "role": "admin", "object": "work_item", "read": true, "create": true, "update": true, "delete": true },
    { "role": "member", "object": "work_item", "read": true, "create": true, "update": true, "delete": false }
  ],
  "pages": [
    { "api_name": "overview", "label": "Overview", "nav_order": 0, "definition": { "blocks": [] } }
  ]
}
```

Use only supported field kinds: `text`, `textarea`, `boolean`, `integer`,
`decimal`, `currency`, `percent`, `date`, `datetime`, `email`, `phone`, `url`,
`picklist`, `multipicklist`, `reference`, or `readonly_formula`. A reference's
`reference_targets` must name objects in the same proposal. Use `owner`
visibility when members should see only their own rows; use `org` for shared
directories. Define both admin and member permissions for every object.

API names are permanent. Choose short, clear snake_case names once; change
labels later when wording changes. Picklist values are stable stored values,
so prefer durable values such as `closed_won` over display prose.

## Adapt a blueprint

Call `mcp__neko_records__browse_blueprints` without an id to discover the
shipped priors, then call it with the selected blueprint id to load the exact
`app_create` payload. Never invent a blueprint payload from its name.

Use the shipped CRM prior for relationship and pipeline work: accounts,
contacts, opportunities, and activities. Use the support prior for request
triage: organizations, requesters, tickets, and comments. Adapt entities,
stages, permissions, and layouts to the operator's language rather than
forcing their workflow into the prior. Always emit a complete `app_create`
payload; a blueprint name alone is not executable.

## Start from a spreadsheet

Inspect the CSV headers and representative rows before proposing a schema.
Infer field kinds conservatively and show assumptions. Map stable source keys
to duplicate detection; never promise upsert or overwrite because baseline
imports are insert-only.

- For a new app or object, propose `app_create` or `app_object_create` first.
  After approval, offer the reviewed column mapping through the app's Import
  workspace or `records_import_start` when a staged source path is available.
- For an existing object, map headers to existing fields. Propose optional new
  fields separately for unmatched columns before starting the import.
- Treat the mapping, row count, sample rows, and duplicate key as approval
  material. Never route thousands of rows through `record_create` one by one.

## Evolve an existing app safely

Use only the typed installed actions:

- `app_object_create` for a complete new object.
- `app_field_add` for a new optional field.
- `app_field_modify` for labels, validations, read-only state, picklist values,
  or reference targets; never change a stored field's type in place.
- `app_permission_set` and `app_layout_update` for access and presentation.
- `app_object_archive` or `app_field_archive` to hide obsolete schema while
  retaining data.

For a new required field, propose an additive sequence: add it optional,
backfill through governed writes/import, verify, then make it required. For a
type change, add a new field, backfill, verify, and archive the old field.
Never propose `hard_drop`; it is not an agent action. Archived means hidden,
not deleted.

## Proactive app suggestions

When durable memory shows the same ad-hoc view, spreadsheet, or hand-tracked
list recurring, suggest an app as a normal finding or short in-thread idea.
Do not emit an approval card until the operator accepts the direction. If they
decline, drop the suggestion without repeating it.
