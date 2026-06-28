# How OpenNeko is licensed

OpenNeko uses an **open-core** model:

| Area | License | What it covers |
|---|---|---|
| **Core** | [Apache License 2.0](LICENSE) | The OpenNeko core source code unless a file says otherwise. |
| **Enterprise** | [OpenNeko Commercial License](LICENSE-COMMERCIAL.md) | Governance, compliance, and org-scale administration features identified by `LicenseRef-OpenNeko-Commercial`. |
| **Third-party and modular components** | Their own licenses | Dependencies, bundled skills, external agents, plugin code, and other separately licensed components. |

The Apache License 2.0 permits use, modification, distribution, commercial use,
and hosted use of the OpenNeko core, subject to its terms. It requires
preservation of required copyright, patent, trademark, attribution, license, and
NOTICE materials in distributed copies and derivative works.

The Apache License 2.0 does **not** grant rights to use the OpenNeko name, logo,
or branding. Those marks are governed separately by [TRADEMARKS.md](TRADEMARKS.md).

## Apache-licensed core

The Apache-licensed core includes the default OpenNeko runtime and self-hosted
product surface unless a file carries a different license notice:

- The agent runtime, Ask workspace, briefings, workflows, and watchers.
- The plugin system and sandbox, with on-the-wire model-key injection.
- Secrets encryption at rest, multi-tenant isolation, the RBAC engine, and
  local / solo authentication.
- Personal access passes, memory integrity, and manual approval gates.
- Multi-user collaboration over chat channels such as Slack and Telegram.
- Public plugin interfaces and manifests shipped from this repository.

Original OpenNeko core code authored by Amit Deshmukh is copyrighted by Amit
Deshmukh. Contributor-authored code remains owned by its respective copyright
holders and is licensed under the applicable contribution terms. See
[NOTICE](NOTICE) and [CLA.md](CLA.md).

## Enterprise components

Some features are enterprise components and are not licensed under Apache 2.0.
They are identified by the SPDX header:

```text
SPDX-License-Identifier: LicenseRef-OpenNeko-Commercial
```

Enterprise components include features whose buyer is an organization's IT,
security, or compliance function:

- **Teams on the web** — enterprise SSO / SAML / OIDC, SCIM provisioning, and web
  multi-user login.
- **Approval policy engine** — auto-approval rules and per-organization policies
  (manual approval stays in the core).
- **Compliance & audit** — the tamper-evident, hash-chained audit log with SIEM
  export, and dual-identity audit trails.
- **Governance** — install / plugin policy, behavioral alarms, org / hardened
  security profiles, and context-versioning governance.
- **External secrets** — the Infisical vault integration.

You may use enterprise components only under a valid commercial agreement or as
otherwise allowed by [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

## Third-party and modular components

OpenNeko depends on and can interoperate with software that is not owned by
OpenNeko. Those components remain under their own licenses, even when referenced,
bundled, invoked, or integrated by OpenNeko.

Examples include:

- Runtime dependencies and container-layer software listed in
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
- Hermes Agent, when used as an external/modular agent runtime, under its
  upstream MIT license.
- Claude Agent / Claude Code / Anthropic SDK components and related skill
  formats under their upstream package, repository, or service terms.
- Built-in skills that carry their own `license:` frontmatter or local
  `LICENSE.txt` files.
- Third-party plugins that communicate with OpenNeko across the plugin RPC
  boundary.

If an individual file, package, bundled skill, plugin, or dependency includes a
different license notice, that notice controls that component.

## Plugins are independent works

OpenNeko loads plugins as separate processes inside sandboxes, across a defined
RPC boundary. A third-party plugin that communicates with OpenNeko only across
that boundary is an independent work and is **not** licensed merely by being
used with OpenNeko. Plugin authors may license their plugins however they choose.

The OpenNeko plugin interfaces and in-repository plugin support code are covered
by the repository license unless a file says otherwise.

## Trademarks and hosted services

"OpenNeko" and the OpenNeko logo are trademarks of Amit Deshmukh / OpenNeko.
Neither Apache 2.0 nor the Commercial License grants trademark rights.

Apache 2.0 does not prohibit a third party from running a hosted or managed
service based on the OpenNeko core. It does require compliance with the license
and NOTICE obligations for distributed copies. Separately, the trademark policy
prohibits unauthorized use of the OpenNeko name, logo, or confusingly similar
branding for forks, hosted services, commercial offerings, or endorsement claims.

See [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

Contributions are welcome under the [Contributor License Agreement](CLA.md).
The CLA lets contributors keep ownership of their contributions while granting
the project the rights needed to license OpenNeko under Apache 2.0, maintain the
commercial edition, and relicense if necessary. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Getting a commercial license

Contact us via <https://openneko.app> to discuss enterprise features, official
OpenNeko hosted-service branding, trademark permission, support, or partnership
terms.
