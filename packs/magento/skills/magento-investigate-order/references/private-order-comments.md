# Governed private order comments

The pack supports only `magento.add_internal_order_comment`. Use it only after
the user explicitly asks to record a note and an OpenNeko administrator
approves the proposed action.

Supply the resolved numeric Magento order `entity_id` and a concise factual
comment. The adapter fixes these values and they must not be overridden:

```json
{
  "is_customer_notified": 0,
  "is_visible_on_front": 0
}
```

OpenNeko performs a precondition read, one write attempt, and a reconciliation
read. Do not report success until the action receipt confirms it. A timeout may
have committed upstream; an outcome of `reconcile_required` must be checked and
must never be blindly retried.

If the action reports `graphjin_version_unsupported`,
`integration_token_missing`, `integration_token_invalid`, or `acl_missing`,
explain that the private-note step is unavailable and preserve the completed
read-only investigation. Never substitute raw REST, GraphQL, SQL, `curl`, or an
admin credential.
