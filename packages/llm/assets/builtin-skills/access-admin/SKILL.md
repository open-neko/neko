---
type: Skill
name: access-admin
description: Assign, change, inspect, or remove user and SSO-group access to OpenNeko generated apps, objects, and fields through governed entitlement actions. Use when an administrator asks who can access an app, to grant or revoke app access, or to set read/create/update/delete or field read/write permissions.
---

# Access admin

Manage generated-app access through approval-gated actions. Never edit access
tables, role permissions, identity memberships, or GraphJin policy directly.

## Resolve exact subjects and resources

1. Call `mcp_neko_user_manager_list_users` to resolve the exact `app_user.id`
   or stable `sso_group.id`. Names and emails are display data. If multiple
   matches remain, ask the administrator to choose.
2. Call `mcp_neko_records_browse_catalog` to resolve the exact app, object,
   and field API names. Its output reflects the acting administrator's data
   access; an administrator without app-data access may need the target API
   names supplied from the access-management surface.
3. Never guess an ID or substitute a mutable SSO group display name for its ID.

## Preserve the hierarchy

Access is allow-only and closed by default:

1. App access is required before any object grant.
2. Object read is required for create, update, or delete.
3. Field read is required for field write.
4. Field write also requires object create or update and cannot override a
   schema read-only field.

An app grant alone makes no object data readable. When the request says only
"give access," ask which objects, operations, and fields are intended. Do not
silently grant every object or field. Effective access is the union of a
user's direct grants and current SSO-group grants.

The synthetic solo operator already has full access when SSO/multi-user mode
is not in use; do not create fake entitlement rows for it.

## Submit governed actions

Use only these installed actions with `scope: internal`:

- `app_access_grant`

```json
{ "app": "crm", "subject_type": "group", "subject_id": "<sso_group.id>" }
```

- `app_access_revoke` — removes the app grant and all child grants.

```json
{ "app": "crm", "subject_type": "user", "subject_id": "usr_123" }
```

- `app_object_permission_set`

```json
{
  "app": "crm",
  "object": "activity",
  "subject_type": "group",
  "subject_id": "<sso_group.id>",
  "read": true,
  "create": true,
  "update": true,
  "delete": false
}
```

- `app_field_permission_set`

```json
{
  "app": "crm",
  "object": "opportunity",
  "field": "amount",
  "subject_type": "group",
  "subject_id": "<sso_group.id>",
  "read": true,
  "write": false
}
```

Summarize the exact subject, app, object/field, and before-to-after capability
being proposed. Revocation is high-impact: state that child grants are removed.
Approval is not execution; report only the action's actual terminal result.

## Guardrails

- Require a live administrator actor; org-admin status does not itself grant
  app-data access in SSO/multi-user mode.
- Never alter IdP memberships to manufacture access. Group membership is
  synchronized from the provider or SCIM.
- Never widen permissions to work around an absent catalog result.
- Never expose a field through a layout, export, search, reference expansion,
  or agent answer when its read grant is absent.
- Resolve current users/groups again before each change so deactivation and
  membership removals take effect promptly.
