# How OpenNeko is licensed

OpenNeko-owned source code in this repository is licensed under the
[Apache License 2.0](LICENSE), unless an individual file clearly says
otherwise.

That means OpenNeko-owned features are not split into a separate commercial
source-code license in this repository.

The Apache License 2.0 permits use, modification, distribution, commercial use,
and hosted use of OpenNeko-owned code, subject to its terms. It requires
preservation of required copyright, patent, trademark, attribution, license, and
NOTICE materials in distributed copies and derivative works.

The Apache License 2.0 does **not** grant rights to use the OpenNeko name, logo,
or branding. Those marks are governed separately by [TRADEMARKS.md](TRADEMARKS.md).

## Copyright and attribution

Original OpenNeko code authored by Amit Deshmukh is copyrighted by Amit
Deshmukh. Contributor-authored code remains owned by its respective copyright
holders and is licensed under the applicable contribution terms. See
[NOTICE](NOTICE) and [CLA.md](CLA.md).

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
Apache 2.0 does not grant trademark rights.

Apache 2.0 does not prohibit a third party from running a hosted or managed
service based on OpenNeko-owned code. It does require compliance with the
license and NOTICE obligations for distributed copies. Separately, the trademark
policy prohibits unauthorized use of the OpenNeko name, logo, or confusingly
similar branding for forks, hosted services, commercial offerings, or
endorsement claims.

See [TRADEMARKS.md](TRADEMARKS.md).

## Contributing

Contributions are welcome under the [Contributor License Agreement](CLA.md).
The CLA lets contributors keep ownership of their contributions while granting
the project the rights needed to license OpenNeko under Apache 2.0 and relicense
if necessary. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Commercial relationships

Apache 2.0 covers the OpenNeko-owned code. Commercial arrangements, if any, are
for services such as support, official OpenNeko hosted-service branding,
trademark permission, certification, partnership, or other non-code rights.
