---
name: graphjin-config
description: "Use when viewing or proposing changes to GraphJin sources, roles, access, security, runtime settings, and reload behavior."
---

# GraphJin Config

Use the source-config manager tools for GraphJin configuration requests.

## Workflow

1. Call `mcp__neko_source_config_manager__describe_source_graph` to identify
   the selected GraphJin data engine and its current sources.
2. Call `mcp__neko_source_config_manager__ask_graphjin_config_agent` with the
   user's configuration question or requested change.
3. For a view or explanation, answer with the redacted configuration-agent
   result and the relevant source-graph details.
4. For a database source registration, call
   `mcp__neko_source_config_manager__list_source_secret_names` and use a stored
   name as `secretRef`. When the required name is absent, direct the admin to
   Admin > Settings > GraphJin Config to add it.
5. For a supported edit, call
   `mcp__neko_source_config_manager__request_source_config_change` with the
   confirmed fields.
6. Summarize the proposed change and its approval status.

A view or explanation succeeds when the response includes the redacted result
from `ask_graphjin_config_agent`. An edit succeeds when the response includes
the proposal result from `request_source_config_change`.

When a tool returns an error, report the error and the workflow step that needs
attention.

## Supported Edits

- `register_source`: provide `name`, one of the customer source kinds
  (`database`, `api`, or `file`), and the fields for that kind. Database uses
  connection metadata and a stored `secretRef`; API uses an OpenAPI specs
  directory; file uses a backend plus a local root or object-store bucket.
  A suitable database default is `read: authenticated`, `write: blocked`, and
  `delete: blocked`.
- `set_source_access`: provide the source name and confirmed `read`, `write`,
  and `delete` access modes.
- `add_role`: provide the role name and the JWT match expression confirmed by
  the admin.

Prefer additive changes: source registration upserts by source name, source
access patches the named source, and role changes upsert by role name. Treat a
full replacement as a separate configuration operation requiring the current
configuration and explicit admin intent.
