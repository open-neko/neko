---
name: magento-manage-catalog
description: Prepare and execute governed Magento product, category, assignment, and price changes with classification, caps, before images, reconciliation, and safe inverse drafts. Use when a user asks to create, edit, bulk update, move, assign, price, or delete catalog entities.
license: Apache-2.0
metadata:
  hermes:
    tags: [magento, catalog, products, categories, pricing, change-set]
    category: commerce
    requires_toolsets: [graphjin]
    related_skills: [magento-check-inventory, magento-run-promotions, magento-review-performance]
---

# Manage the Magento catalog

Resolve the store scope and exact product SKU or category ID, then read the
current entity before proposing a change. Use only an operation installed in
`magento.manage_catalog`. Include a stable idempotency key, one `entity_ref`
per row, path parameters, and the Magento request body.

Show the before image, requested diff, inferred class, caps, row count, and
whether the operation is reversible. Unknown attributes and price, tax,
visibility, status, website assignment, or destructive changes escalate to
Class 1 human approval. A named Class 2 automatic rule may proceed only inside
its stored daily cap and entity cooldown.

For more than one product, prefer `product_bulk_update`. Treat Magento's bulk
UUID as submission evidence, not completion. Wait for terminal operation
statuses and then read every product back. If any row drifts after preview,
submit nothing. If reconciliation is ambiguous, report `reconcile_required`
and never retry automatically.

Undo is a new `magento.undo_changeset` request. Generate it only for an applied,
reversible change-set and only after the current value still matches the
recorded reconciled image.

Boundary: Never bypass `magento.manage_catalog` or `magento.undo_changeset` with SQL, raw GraphQL, raw REST, `curl`, or a terminal, and never describe a preview or bulk submission as an applied change.
