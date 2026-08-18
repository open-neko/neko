---
type: Skill
name: support-desk
description: Model or interpret a generated customer-support app, especially for Zendesk-shaped data. Use when a user wants a support desk, ticket and requester tracking, Zendesk replacement or import, queues and assignment, service priorities or statuses, or help interpreting a support import report.
---

# Support Desk

Apply support-domain knowledge through the generic records engine. Use
`mcp__neko_records__browse_blueprints` with `blueprint: "support"` to load the
canonical starting payload. Before proposing or changing the app, read
`../app-builder/SKILL.md` completely and follow it to adapt the loaded payload.
Before reading or writing support rows, read `../records/SKILL.md` completely.
The blueprint is a prior, not a fixed ticketing product.

## Model the service workflow

- Organization is the customer company or service account.
- Requester is the person asking for help and may reference an organization.
- Ticket is the unit of triage, ownership, status, priority, and SLA timing.
- Comment is the durable conversation entry. Keep author, public/internal
  visibility, body, and creation time when the source provides them.
- Add queues, products, incidents, or custom objects only when the operator's
  routing and reporting workflow needs them.

Use `reference` fields for requester, organization, ticket, and queue links;
`textarea` for descriptions/comment bodies; `datetime` for opened, due, and
resolved timestamps; and picklists for status, priority, type, and channel.

## Status, priority, and assignment

The canonical status prior is new → open → pending → solved → closed, and the
priority prior is low / normal / high / urgent. Adapt these values to the
operator's actual lifecycle. Stable values are permanent data; labels may be
friendlier. Preserve imported unknown values for explicit mapping rather than
silently treating them as open or normal.

Ticket assignee or owner language normally maps to `owner_user_id` with
`visibility: owner` when members should see only their assigned tickets.
Queues are business references, not a replacement for actor ownership. Do not
guess an OpenNeko user for an unlinked source assignee.

Keep internal comments distinguishable from requester-visible replies. Do not
promise outbound email, SLA escalation, or automations merely because their
fields exist; those are separate governed workflows.

## Zendesk-shaped imports

Map common source concepts as follows, then adapt:

- organization → `organization`
- user with requester role → `requester`
- ticket → `ticket`
- ticket comment or audit body → `comment`
- group → `queue` when queue routing matters

Keep connector instance plus source ID so identical IDs from separate Zendesk
accounts never collide. Preserve requester and organization rows even when a
legacy ticket has a dangling relationship; report the integrity issue instead
of inventing a target.

Baseline CSV import is insert-only. In an import report, distinguish inserted,
duplicate, rejected, unresolved reference, and unlinked/conflicting owner
counts. Never describe duplicates as updates or assume a rejected comment means
its parent ticket failed too.

Do not claim a CSV load is a live mirror. Connected mirror mode stays locally
read-only until an explicit final delta, watermark verification, and cutover.

## Working with support records

Use `$records` for every read or write. Resolve the exact ticket/requester/
organization/comment and any reference IDs before proposing changes. For
ambiguous tickets, disambiguate with ticket ID, requester, subject, status,
creation time, or organization; never choose the first similar subject.
