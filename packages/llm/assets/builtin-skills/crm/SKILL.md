---
name: crm
description: Model or interpret a generated CRM app, especially for Salesforce-shaped sales data. Use when a user wants a CRM, sales pipeline, account/contact/deal tracking, Salesforce replacement or import, opportunity stages, ownership mapping, or help interpreting a CRM import report.
---

# CRM

Apply CRM domain knowledge through the generic records engine. Use
`mcp__neko_records__browse_blueprints` with `blueprint: "crm"` to load the
canonical starting payload, then follow `$app-builder` to adapt and propose it.
The blueprint is a prior, not a mandatory sales process.

## Model the sales workflow

- Account is the company or buying organization. Keep it org-visible unless
  the operator explicitly partitions accounts by owner.
- Contact is a person related to an account. Preserve contacts without an
  account when legacy data permits them; report the missing relationship.
- Opportunity is the deal or revenue event. Usually make it owner-visible and
  reference its account.
- Activity is a call, meeting, email, note, or task. Model the user's actual
  follow-up workflow rather than copying every source activity subtype.
- Custom Salesforce objects become ordinary record objects only when the
  operator needs their workflow. Never add CRM behavior to engine code.

Use `reference` fields for relationships, `currency` for monetary amount,
`date` for close dates, and `percent` for probability. Keep source IDs as text
during migration so relationships remain stable.

## Stages and status

Ask for the pipeline stages when they materially differ from the canonical
qualification → discovery → proposal → negotiation → closed-won/lost flow.
Store durable snake_case values such as `closed_won`; labels may change later.
Do not infer probability, forecast category, or a win/loss state from a stage
name unless the operator defines that mapping.

For imported Salesforce data, preserve unfamiliar stage values and surface
them for mapping. Never silently coerce an unknown value into the closest
canonical stage.

## Ownership

Words such as owner, rep, assignee, book of business, and "my deals" normally
map to the records substrate's `owner_user_id` and object `visibility: owner`.
Do not create a second ordinary `owner` field unless the source owner's raw ID
must be retained for migration evidence.

An imported source owner is not automatically an OpenNeko user. Treat linked,
unlinked, conflict, and ignored identity states distinctly. Never guess an
owner match from a similar display name or email.

## Salesforce-shaped imports

Map common source objects as follows, then adapt:

- `Account` → `account`
- `Contact` → `contact`, referencing `account`
- `Opportunity` → `opportunity`, referencing `account`
- `Task` and `Event` → `activity` when one combined timeline fits

Use source-scoped IDs and connector identity; two Salesforce instances may
contain the same external ID. Preserve polymorphic `WhoId` and `WhatId` target
sets rather than guessing one object. Do not manually rewrite 15-character
Salesforce IDs; the connector's normalization owns that rule.

Baseline CSV import is insert-only. Interpret reports precisely:

- inserted means a row committed through GraphJin;
- duplicate means a stable key already existed and was not overwritten;
- rejected means validation failed—summarize reasons and row locations;
- unresolved reference or identity means the row may exist but needs mapping.

Do not claim a CSV load is a live mirror. Connected mirror mode remains
read-only locally until an explicit verified cutover completes.

## Optional starter watches

The canonical CRM blueprint includes three disabled-by-default
`starter_workflows`. Offer them as explicit choices before proposing the app:

- opportunities with no activity in 30 days;
- records owned by an unlinked or departed source user;
- deals closing this month, grouped by owner.

Preserve every choice in the `app_create` payload and enable only the watches
the operator selected. Each enabled workflow uses a durable GraphJin watch as
its primary wake-up path and a scheduled fallback, then publishes the same
deterministic result into Briefing. App creation and terminal imports also
produce Briefing summaries; use the attached import report for row, identity,
and staging-cleanup facts rather than reconstructing them from chat history.

## Working with CRM records

Use `$records` for every read or write. Resolve exact account, contact,
opportunity, activity, and reference IDs before proposing changes. When several
companies or people share a name, disambiguate with stable facts such as domain,
email, city, account, stage, or close date.
