---
name: graphjin-config
description: "Use when inspecting, creating, editing, or explaining GraphJin source-mode config, sources, roles, RBAC, source access, MCP config-update capability, and OpenNeko source_config_admin proposals."
---

# GraphJin Config

Use this skill before any GraphJin source-mode configuration work: viewing
sources, registering a source, changing source access, adding roles, explaining
RBAC, or discussing the `gj_config` MCP/config-update path.

## Guardrails

- Target the customer GraphJin data engine only. Never configure OpenNeko's
  internal GraphJin service.
- Treat `mcp.allow_config_updates` as dangerous. It should be enabled only for
  the customer GraphJin endpoint, only when the OpenNeko admin toggle is on, and
  only behind OpenNeko admin approval.
- Never ask for or print database passwords, tokens, connection strings with
  credentials, or other secret values. Use stored secret names as `secretRef`.
- Do not mutate config directly from chat. Use the OpenNeko
  `source_config_admin` request path and wait for admin approval.
- Prefer additive GraphJin update primitives. `update_sources` upserts by source
  name, `source_patches` patches existing sources by name, and `roles` upserts
  roles. Avoid replace-all `sources` changes unless an admin explicitly requests
  a full config rewrite and the current config has been captured.

## Workflow

1. Read this `SKILL.md`.
2. Inspect current state with
   `mcp__neko_source_config_manager__describe_source_graph`.
3. Use `mcp__neko_source_config_manager__ask_graphjin_config_agent` to have
   the selected GraphJin explain its redacted current configuration, security
   posture, relevant config recipe, and expected reload impact. This agent is
   host-verified as globally read-only and cannot apply changes.
4. For source registration, call
   `mcp__neko_source_config_manager__list_source_secret_names` and choose an
   existing `secretRef`. If the needed secret is missing, tell the operator to
   add it in Admin > Settings > GraphJin Config.
5. Propose changes only with
   `mcp__neko_source_config_manager__request_source_config_change`.
6. Tell the operator exactly what was proposed and that an admin approval is
   required before the change is applied.

## Supported Proposals

Use `request_source_config_change` only for the operations it exposes:

- `register_source`: add a source. For databases, provide non-secret
  connection fields such as `name`, `kind`, `host`, `port`, `dbname`, `user`,
  and `secretRef`. Prefer `read: authenticated`, `write: blocked`, and
  `delete: blocked` unless the operator asks for stricter access.
- `set_source_access`: change a source's `read`, `write`, or `delete` access.
  Valid modes are `public`, `authenticated`, `account`, `owner`, `admin`, and
  `blocked` for reads; writes and deletes should normally be `blocked` or
  `admin`.
- `add_role`: add or update a role selected from verified identity claims.
  Use clear role names such as `user` and `admin`; only add role matches that
  follow the deployment's trusted token shape.

If a request requires identity policy, namespace columns, table classification,
artifact stores, raw GraphJin roots, or arbitrary YAML beyond these operations,
explain that the current OpenNeko admin tool does not expose that edit yet and
avoid inventing unsupported payload fields.

## Source-Mode Rules

- In GraphJin source mode, `sources:` is the canonical shape for databases,
  APIs, code indexes, file sources, GraphJin system roots, and workflow roots.
  Tables point to `tables[].source`; do not introduce legacy
  `tables[].database` or top-level `database`/`databases` for new configs.
- OpenNeko-managed source-mode config must use the install-derived JWT secret
  written by host provisioning. Do not hard-code `auth.jwt.secret` values in
  proposals or examples; use the deployment template placeholder and let
  OpenNeko reconcile it.
- Keep the GraphJin system source separate from application data sources. Use a
  `kind: graphjin` source for catalog/control-plane roots such as `gj_catalog`
  and `gj_config`.
- Set `gj_config`, `gj_security`, and `gj_runtime` to GraphJin's `admin` access
  class. GraphJin's verified JWT role is a second boundary behind OpenNeko's
  live admin-role check, capability toggle, approval rule, and worker adapter.
- Keep `agent.read_only: true`. OpenNeko refuses to call a GraphJin config
  agent whose status endpoint reports that read-only mode is disabled.
- For agentic deployments, keep `mcp.legacy_discovery: false` and
  `mcp.allow_mutations: false` unless the admin has a specific reason to relax
  them.
- When `mcp.allow_dev_tools: false`, use `gj_catalog` through
  `graphjin cli execute_graphql` for source inspection. Do not rely on MCP dev
  tools such as `list_tables`, `describe_table`, `get_table_sample`,
  `find_path`, `explore_relationships`, `health`, or `fix_query_error`.

## RBAC Checklist

- Confirm the verified identity shape before changing access: user id claim
  such as `sub`, role claims such as `role` or `roles`, and tenant/account
  claims such as `account_id` or `org_id`.
- For account-scoped data, prefer source access `read: account` with a real
  namespace column such as `account_id` and fail closed for tables without that
  column. If the current OpenNeko tool cannot set the namespace fields, surface
  that limitation instead of filing a partial account-mode proposal.
- For single-tenant demos, `read: authenticated`, `write: blocked`, and
  `delete: blocked` is the default safe posture.
- Do not use `public` for business data unless the operator explicitly confirms
  the data is shared/reference data.
- Writes and deletes require a stronger justification than reads. Prefer
  `blocked`; use `admin` only for trusted operational maintenance.

## Verification

After approval and execution, inspect the source graph again. Confirm the source
appears with the expected kind, non-secret connection metadata, access posture,
and catalog revision. Never verify by exposing secret values.
