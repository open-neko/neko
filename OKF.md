# Adopting the Open Knowledge Format (OKF)

Status: proposal (analysis complete, no implementation yet)

## Summary

OpenNeko's core promise is that "the findings, rules, and decisions are yours" —
but today the only complete way to take your knowledge with you is an encrypted
whole-Postgres backup that is opaque and keyed to the install. The
[Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(OKF, Apache-2.0, currently v0.2) is a vendor-neutral spec for exactly the
artifact we are missing: a directory of Markdown files with YAML frontmatter,
cross-linked with ordinary markdown links, readable by humans, git, and any
OKF-aware tool.

We are unusually close to it already. The config-VCS snapshot
(`packages/llm/src/config-vcs/snapshot.ts`) serializes durable memories to
one Markdown-plus-frontmatter file per memory; workflows
(`packages/llm/src/workflows/store.ts`) and skills (`SKILL.md`) are already
Markdown with frontmatter. OKF's only hard requirement is a `type` field.

## Guiding principle

**OKF carries knowledge that humans author, approve, or own — never anything
derived from a live system.** GraphJin's `gj_catalog` is the authoritative,
live source for schema knowledge; the boot-time knowledge pack
(`packages/llm/src/knowledge-pack.ts`) is a derived cache and stays out of
scope. Exporting a derived snapshot would create a second copy that drifts
from what the agent actually queries. User *corrections* about data ("revenue
means net of refunds") already live as memories (`metric_definition`,
`business_rule`) and flow through the items below naturally.

## Scope

### 1. Make the config-VCS org repo an OKF bundle

The per-org git tree (`skills/`, `workflows/`, `memory/`) becomes a
conformant bundle:

- add a `type` field to each file's frontmatter (mapped from memory `kind`,
  or `Workflow` / `Skill`)
- generate `index.md` files per directory (OKF's progressive-disclosure
  reserved file)
- declare `okf_version: "0.2"` in the bundle-root `index.md`

Near-zero cost; turns an informal internal layout into a documented contract.

### 2. Knowledge export/import CLI

New CLI verbs alongside `backup`/`restore` producing and consuming a
standalone bundle (git repo or tarball — both are OKF's blessed distribution
forms). The importer is the real new engineering:

- recompute embeddings on ingest (pgvector data never travels)
- re-mint `integrity_hmac` per receiving org (seals never travel)
- enforce team-layer-only content — personal-layer rows
  (`user_id`-scoped overlays, suppressions) never enter a bundle, matching
  the existing snapshot rule

This complements — does not replace — the encrypted Postgres backup, which
remains the full-fidelity disaster-recovery path.

### 3. Trust and provenance fields on exported memories

Postgres remains the system of record; frontmatter is a projection written at
export time, exactly like the memory text itself. OKF v0.2's optional field
families map almost one-to-one onto `work_memory` / `work_pending_memory`:

| OpenNeko (packages/db/src/schema.ts) | OKF v0.2 frontmatter |
|---|---|
| `kind` (`business_rule`, `metric_definition`, …) | `type` |
| agent-authored via memory fence, `source_run_id` | `generated: { by: openneko/<version>, at: … }` |
| pending memory accepted by a human | `verified: [{ by: "human:<id>", at: … }]` |
| `proposed` / `accepted` state | `status: draft` / `status: stable` |
| `expires_at` / `archived_at` | `stale_after` / `status: deprecated` |
| `use_count` | `sources[].usage_count` |

Why carry them at all when Postgres has them: the bundle must be useful when
Postgres isn't there.

- **Round-trip fidelity** — an importer without these fields must either
  flatten everything to unverified drafts (forcing re-approval of vetted
  rules) or mark everything trusted (bypassing the receiving org's approval
  gate). With them, accepted rules land accepted and drafts land as
  proposals.
- **External consumers** — any OKF-aware tool can prefer `status: stable`,
  human-`verified` concepts and skip stale ones. Without the fields, every
  concept in the bundle looks equally authoritative.
- **Auditability** — "who vouched for this rule and when" is readable in the
  file and diffable across commits, without a live install.

Constraint: the format must not invent trust state the database does not
hold. The DB defines what is true; frontmatter carries it out the door.

### 4. Starter knowledge packs

A knowledge-level sibling to Records blueprints
(`packages/records/blueprints/`): shippable bundles of metric definitions,
business rules, and workflows for a vertical (e.g. retail ops, SaaS
finance). Imported on day one instead of teaching every fresh install the
same definitions from scratch. Plain Markdown means packs are reviewable
before install — which matters given how policy-sensitive injected business
rules are.

## Out of scope

- **Schema knowledge for data sources** — GraphJin owns it live; see the
  guiding principle above.
- **Records data, CSV/Salesforce interchange, backups** — data-level formats
  with working versioned specs (`openneko.records.artifact.v1` etc.). OKF is
  a knowledge/context format, not a data serialization.

## Risks and open items

- **Spec is pre-1.0** (v0.1 June 2026 → v0.2 August 2026, with two breaking
  changes already: `timestamp` → `generated`, body `# Citations` →
  `sources`). Mitigations: the spec's surface is one page, consumers are
  required to degrade gracefully on unknown fields/versions, and we stamp
  `okf_version` so our own tooling can migrate. Treat the bundle layout as a
  versioned output, per the house convention of dotted format IDs.
- **Personal/team layering is not an OKF concept.** The exporter enforces
  team-layer-only, as the current snapshot already does. The layering rules
  themselves are referenced in code comments as `docs/DATA_LIFECYCLE.md`,
  which does not exist yet — writing it is a prerequisite for the importer's
  correctness rules and should land with or before item 2.
- **OpenNeko-specific fields** (confidence, promotion lineage) go in as
  additional frontmatter keys — explicitly permitted; OKF consumers must not
  reject unknown keys.

## Suggested order

1. Item 1 (bundle conformance) — small serializer change, immediate value.
2. `docs/DATA_LIFECYCLE.md` — codify the layering rules the importer depends on.
3. Item 2 (export/import CLI), with item 3's field mapping, plus a JSON
   Schema for the bundle contract in the style of
   `evals/schemas/*.v1.schema.json`.
4. Item 4 (starter packs) once round-trip works.
