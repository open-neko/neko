# How OpenNeko is licensed

OpenNeko uses an **open-core** model with two licenses:

| Edition | License | What it covers |
|---|---|---|
| **Core** | [Elastic License 2.0](LICENSE) (source-available) | Everything except the enterprise components below. Free to self-host and use. |
| **Enterprise** | [OpenNeko Commercial License](LICENSE-COMMERCIAL.md) | Governance, compliance, and org-scale administration features. Requires a paid Commercial Agreement to use in production. |

> OpenNeko is **source-available**, not OSI "open source." You can read,
> self-host, modify, and redistribute the Core, but the Elastic License 2.0
> prohibits offering OpenNeko to third parties as a hosted or managed service and
> prohibits circumventing the license-key / entitlement functionality.

## What's free (Elastic License 2.0)

Everything you need to run OpenNeko securely for yourself or your team:

- The agent runtime, Ask workspace, briefings, workflows, and watchers
- The plugin system and sandbox, with on-the-wire model-key injection
- Secrets encryption at rest, multi-tenant isolation, the RBAC engine, and
  local / solo authentication
- Personal access passes, memory integrity, and manual approval gates
- Multi-user collaboration over chat channels (Slack / Telegram)

## What's enterprise (Commercial License)

Features whose buyer is an organization's IT, security, or compliance function —
they scale with org size, not individual use:

- **Teams on the web** — enterprise SSO / SAML / OIDC, SCIM provisioning, and web
  multi-user login
- **Approval policy engine** — auto-approval rules and per-organization policies
  (manual approval stays free)
- **Compliance & audit** — the tamper-evident, hash-chained audit log with SIEM
  export, and dual-identity audit trails
- **Governance** — install / plugin policy, behavioral alarms, org / hardened
  security profiles, and context-versioning governance
- **External secrets** — the Infisical vault integration

The authoritative per-feature mapping (with the feature keys that gate each one)
lives alongside the code; enterprise files carry the SPDX header
`LicenseRef-OpenNeko-Commercial`.

## Plugins are not derivative works

OpenNeko loads plugins as separate processes inside sandboxes, across a defined
RPC boundary. A third-party plugin that communicates with OpenNeko only across
that boundary is an independent work and is **not** a derivative work of
OpenNeko. Plugin authors may license their plugins however they choose.

## Trademarks

"OpenNeko" and the OpenNeko logo are trademarks of the Project Maintainer.
Neither the Elastic License 2.0 nor the Commercial License grants you rights to
use these marks. You may make nominative reference to OpenNeko (for example,
"works with OpenNeko"), but you may not use the name or logo in a way that implies
endorsement, and a redistributed or modified version may not be called
"OpenNeko."

## Contributing

Contributions are welcome under a [Contributor License Agreement](CLA.md), which
lets the project license your contribution under both the Elastic License 2.0 and
the Commercial License. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting a commercial license

Contact us via <https://openneko.app> to discuss an Enterprise subscription.
