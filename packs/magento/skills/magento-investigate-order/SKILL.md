---
name: magento-investigate-order
description: Investigate one Magento order and reconstruct its order, invoice, shipment, credit-memo, and cancellation state for customer-service or operations questions. Use when an order ID or increment ID is supplied, an order appears stuck or inconsistent, or an operator wants to add a private internal note; do not use for aggregate fulfillment or sales reporting.
license: Apache-2.0
metadata:
  hermes:
    tags: [magento, order, customer-service, invoice, shipment, credit-memo]
    category: commerce
    requires_toolsets: [graphjin]
    related_skills: [magento-triage-fulfillment, magento-investigate-refunds, magento-review-performance]
---

# Investigate a Magento order

Produce a privacy-minimized lifecycle explanation for one exact order. Query
`magento_analytics` for evidence and treat it as read-only.

## Resolve the order

Accept a numeric Magento `entity_id` or storefront `increment_id`. Resolve it
to exactly one order before continuing. If there are no matches, say which
identifier was checked. If multiple stores can contain the supplied identifier,
use store scope and other non-personal facts to disambiguate; never choose the
first match silently.

Keep both identifiers in working context. The governed comment action requires
the numeric `entity_id`, even when the user supplied an increment ID.

## Reconstruct the lifecycle

Read [order lifecycle](references/order-lifecycle.md), then gather only the
fields necessary to answer the question:

1. Order creation time, store ID, state, status, base totals, and paid,
   invoiced, shipped, refunded, and cancelled quantities.
2. Invoice documents and item quantities.
3. Shipment documents and item quantities.
4. Credit memos and credited item quantities.
5. Parent order-item SKU, name, and lifecycle quantities when line-level
   reconciliation is needed.

Use document timestamps to form a timeline. Explain discrepancies explicitly:
an order can be placed without being paid, invoiced without being shipped, or
credited without being cancelled. Do not infer an event from status text when
the corresponding document is absent.

Do not request, query, or display customer names, email, phone, addresses, IP
addresses, payment/vault details, credentials, tokens, password data, or Adobe
Marketplace keys. The pack excludes those fields deliberately. If internal
status-history records are unavailable through an approved source, say so
instead of claiming the timeline is complete.

## Explain the finding

Return:

- the identifiers and store scope;
- a chronological lifecycle summary;
- reconciled order- and item-level quantities;
- the exact inconsistency or blocker, if any; and
- the safest next operational check.

Never cancel, invoice, ship, refund, reorder, or edit an order through SQL,
raw GraphQL, raw HTTP, `curl`, or a terminal.

## Optional private note

Only when the user asks to record a note, read
[private order comments](references/private-order-comments.md). The diagnostic
portion remains available even when Magento write readiness is blocked.
