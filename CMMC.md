# CMMC 2.0 — Technical Controls Mapping for OpenNeko

This document maps the **technical controls** of CMMC 2.0 (NIST SP 800-171 Rev 2
for Levels 1–2, plus the NIST SP 800-172 subset for Level 3) against what
OpenNeko delivers today. It covers controls enforced by technology only —
people/process controls (training, personnel security, physical protection,
policy reviews, change-approval workflows) are out of scope here.

> **How to read this.** OpenNeko is a self-hosted software product, not a
> complete information system. CMMC certification applies to the *deploying
> organization's* system boundary; OpenNeko is one component inside it. The
> columns below record which side of that shared-responsibility line each
> control sits on, what OpenNeko itself ships, and the exact features/files
> that back the claim — so an assessor (or we) can verify rather than trust.

**Levels are cumulative:** Level 2 includes all Level 1 controls; Level 3
includes all Level 2 controls plus the 800-172 enhancements.

## Legend

| Column | Values |
|---|---|
| **Applicability** | `Product` — OpenNeko must deliver it · `Deployment` — the hosting environment/org delivers it (OS, network, physical) · `Shared` — both contribute · `N/A` — not meaningful for this system |
| **Status** | `Shipped` — implemented and verifiable in the codebase · `Partial` — implemented with known limits (stated in rationale) · `Gap` — applicable to the product but not implemented · `Inherited` — satisfied by the deployment environment, nothing for the product to do · `N/A` |

---

## Access Control (AC)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.1.1 | Limit system access to authorized users, processes, devices | ✅ | ✅ | ✅ | Product | Partial | With an SSO auth plugin installed, sign-in is per-user OIDC and sessions resolve to `app_user` rows (`apps/web/src/lib/auth.ts`). Without SSO, local mode is a shared admin password — adequate for solo deployments, not for multi-user access control. |
| 3.1.2 | Limit users to permitted transactions/functions | ✅ | ✅ | ✅ | Product | Shipped | Role-gated admin routes (`apps/web/src/lib/admin-auth.ts` `requireAdminActor`); agent world-changing actions are proposal-gated by per-org action policies (`db/migrations/0011_action_stack.sql`, `0020_action_policy_created_by.sql`); plugin installs gated by install policy (`db/migrations/0019_install_policy_scope.sql`, `apps/web/src/lib/install-policy-settings.ts`). |
| 3.1.3 | Enforce CUI flow control | | ✅ | ✅ | Shared | Partial | Agent egress is default-deny, allowed per `(host, binary)` (`OPENSHELL.md`); plugin egress is limited to each manifest's allowlist (`PLUGINS.md`). Network-level flow control beyond the sandbox (VLANs, DLP) is the deployment's. |
| 3.1.5 | Least privilege | | ✅ | ✅ | Product | Shipped | The agent is treated as untrusted: it runs sandboxed with no DB/secret access, reaching the control plane only through a narrow audited broker (`OPENSHELL.md`, `packages/llm/src/work/control-plane.ts`). Admin vs member roles gate administration. |
| 3.1.6 | Non-privileged accounts for non-security functions | | ✅ | ✅ | Product | Partial | Two roles exist (`admin`/`member`, `apps/web/src/lib/auth.ts` `defaultRoleForGroups`); day-to-day use needs no admin role. Finer-grained roles are not yet available; `PLUGINS.md` notes admin/member separation for install policy is future work. |
| 3.1.7 | Prevent non-privileged execution of privileged functions; log attempts | | ✅ | ✅ | Product | Shipped | Non-admin calls to admin routes return 403 (`apps/web/src/lib/admin-auth.ts`); privileged control-plane calls are recorded with dual identity — human + agent (`db/migrations/0042_dual_identity_audit.sql`, `control_plane_audit`). |
| 3.1.8 | Limit unsuccessful logon attempts | | ✅ | ✅ | Product | Gap | No lockout/throttle on the local password sign-in. With SSO the IdP's lockout policy applies, but the local path has no attempt limiting. |
| 3.1.9 | Privacy/security logon banners | | ✅ | ✅ | Product | Gap | No configurable logon banner on `/signin`. |
| 3.1.10 | Session lock with pattern-hiding display | | ✅ | ✅ | Deployment | Inherited | OS-level screen lock on operator workstations; a web app cannot lock the workstation. |
| 3.1.11 | Automatic session termination | | ✅ | ✅ | Product | Partial | Sessions expire after a fixed 12 h TTL (`SESSION_TTL_SECONDS`, `apps/web/src/lib/auth.ts`); rotating `OPENNEKO_SESSION_SECRET` invalidates all sessions globally; disabling a user kills their live session on next request (`getCurrentUser` checks `disabled_at`). No idle-timeout distinct from the absolute TTL. |
| 3.1.12 | Monitor and control remote access sessions | | ✅ | ✅ | Shared | Partial | All web/API access is session-authenticated and privileged calls are audit-chained (see AU rows). VPN/gateway placement and monitoring of the path to the deployment is the operator's. |
| 3.1.13 | Cryptographic protection of remote access | | ✅ | ✅ | Deployment | Inherited | The web app binds locally (`localhost:3000`); remote exposure requires the operator's TLS-terminating reverse proxy/VPN. Session cookies are marked `secure` in production (`apps/web/src/lib/auth.ts` `writeSessionCookie`). |
| 3.1.14 | Route remote access via managed access points | | ✅ | ✅ | Deployment | Inherited | Deployment network architecture. |
| 3.1.15 | Authorize remote execution of privileged commands | | ✅ | ✅ | Product | Shipped | Every world-changing agent action becomes a proposal requiring human approval unless an explicit auto-fire rule exists (`FEATURES.md` "Approval gates"; `action_request` tables, `db/migrations/0011_action_stack.sql`). |
| 3.1.16–3.1.17 | Wireless access authorization + encryption | | ✅ | ✅ | Deployment | Inherited | No wireless surface in the product. |
| 3.1.18–3.1.19 | Mobile device control; encrypt CUI on mobile | | ✅ | ✅ | Deployment | Inherited | OpenNeko ships no mobile agent; mobile browser access is governed by the deployment's MDM. |
| 3.1.20 | Verify/control connections to external systems | ✅ | ✅ | ✅ | Product | Shipped | Outbound connections are default-deny and enumerable: agent egress per `(host, binary)` via the OpenShell gateway, plugin egress per manifest allowlist (`OPENSHELL.md`, `PLUGINS.md`). The model API is the only egress the agent gets by default. |
| 3.1.21 | Limit portable storage on external systems | | ✅ | ✅ | Deployment | Inherited | Host/endpoint control. |

## Audit & Accountability (AU)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.3.1 | Create and retain audit logs | | ✅ | ✅ | Product | Shipped | Per-org append-only audit chain (`db/migrations/0046_audit_chain.sql`, `packages/llm/src/workflows/audit-chain.ts`); every proposal, decision, and execution receipt is retained against its finding (`FEATURES.md` "A complete record of what fired, when, and why"). |
| 3.3.2 | Trace actions to individual users | | ✅ | ✅ | Product | Shipped | Dual-identity audit: every privileged call records both the human and the agent acting for them (`db/migrations/0042_dual_identity_audit.sql`, `0031_actor_in_runs.sql`; `FEATURES.md` "no anonymous actions"). Requires SSO for per-human identity; shared-password local mode weakens attribution. |
| 3.3.4 | Alert on audit logging failure | | ✅ | ✅ | Product | Partial | Chain appends are best-effort so logging failure can't block governed operations, but any gap breaks the hash chain and is detectable by `verifyAuditChain` (`packages/llm/src/workflows/audit-chain.ts`). Detection is on-verify, not a real-time alert. |
| 3.3.5 | Correlate audit records for investigation | | ✅ | ✅ | Product | Shipped | Audit trail is exportable for auditors and SIEM tools (`FEATURES.md` "Tamper-evident log"); natural-language audit queries ("what did the assistant do yesterday and who approved it?") give a readable timeline. |
| 3.3.6 | Audit reduction and report generation | | ✅ | ✅ | Product | Shipped | Plain-language audit timeline plus structured export (`FEATURES.md` "Audit in plain language"). |
| 3.3.7 | Clocks synced to authoritative time source | | ✅ | ✅ | Deployment | Inherited | Container/host NTP. Audit rows use DB timestamps (single Postgres = single clock). |
| 3.3.8 | Protect audit info from unauthorized access/modification | | ✅ | ✅ | Product | Shipped | Hash-chained log: `chain_hash = sha256(prev_hash ‖ seq ‖ payload_hash)`, so any edit or deletion after the fact breaks every later link (`packages/llm/src/workflows/audit-chain.ts`); appends serialize per-org via advisory lock. |
| 3.3.9 | Limit audit management to privileged users | | ✅ | ✅ | Product | Shipped | Audit surfaces sit behind admin-gated routes (`apps/web/src/lib/admin-auth.ts`); no delete/edit API exists for chain rows. |

## Configuration Management (CM)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.4.1 | Baseline configurations and inventories | | ✅ | ✅ | Shared | Partial | The stack is fully declared in versioned compose files (`compose.yml`, `compose.openshell.yml`) and pinned images; installed plugins are inventoried in `openneko.plugins.json` with `installSource` + `installedAt` + `policySnapshot` (`PLUGINS.md`). Host OS baseline is the deployment's. |
| 3.4.2 | Enforce security configuration settings | | ✅ | ✅ | Product | Shipped | Secure-by-default posture: sandboxing is the only mode, not an option (`OPENSHELL.md` "SEC11 made it the default"); install policy defaults deny unverified/git-URL installs (`PLUGINS.md` `/settings/security`); secrets file forced to `0600` (`packages/secret-crypt/src/index.ts`). |
| 3.4.5 | Access restrictions for configuration changes | | ✅ | ✅ | Product | Shipped | Settings and install policy changes require the admin role (`apps/web/src/lib/admin-auth.ts`); agent-proposed configuration changes go through approval gates (`FEATURES.md`). |
| 3.4.6 | Least functionality | | ✅ | ✅ | Product | Shipped | Agent and plugins run in sandboxes with only declared capabilities; on hosts that can't run the sandbox runtime, the plugin subsystem is disabled rather than degraded to unsandboxed (`PLUGINS.md`). |
| 3.4.7 | Restrict nonessential programs/ports/protocols/services | | ✅ | ✅ | Shared | Shipped | Default-deny egress per sandbox; worker admin endpoint is loopback-only, never exposed (`apps/web/src/lib/auth.ts` topology note). Host firewalling is the deployment's. |
| 3.4.8 | Allow-by-exception (application allowlisting) | | ✅ | ✅ | Product | Shipped | Applied to the product's extension points: plugins install only per policy, egress only per manifest allowlist, and marketplace packages carry integrity hashes verified at install (`packages/plugin-install/src/manifest.ts`, `run-install.ts`). OS-level allowlisting is the deployment's. |
| 3.4.9 | Control and monitor user-installed software | | ✅ | ✅ | Product | Shipped | Install policy enforced at CLI, worker, and web (`FEATURES.md` "Install policy"); policy changes flag (not yank) pre-existing installs for manual review (`PLUGINS.md`); unverified installs print loud warnings and remain sandboxed. |

## Identification & Authentication (IA)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.5.1 | Identify users, processes, devices | ✅ | ✅ | ✅ | Product | Partial | With SSO: unique `app_user` per person keyed by IdP-stable `sub` (`apps/web/src/lib/auth.ts` `upsertUserFromIdentity`). Without SSO: shared admin password — no per-user identity. Deploy with an auth plugin to satisfy this. |
| 3.5.2 | Authenticate identities before access | ✅ | ✅ | ✅ | Product | Shipped | All app access requires a valid session (HMAC-signed cookie, constant-time verification, expiry enforced — `apps/web/src/lib/auth.ts` `decodeSession`); SSO flow guards against CSRF/open-redirect via signed state cookies (`writeStateCookie`, `encodeReturnPath`). |
| 3.5.3 | Multifactor authentication | | ✅ | ✅ | Shared | Partial | Delegated to the IdP via the OIDC auth plugin (e.g. Scalekit) — enforce MFA there. No native MFA on the local password path. |
| 3.5.4 | Replay-resistant authentication | | ✅ | ✅ | Product | Shipped | OIDC authorization-code flow with single-use signed state (`readAndClearStateCookie` deletes on read); session cookies are HMAC-bound with expiry and are `httpOnly`/`secure`/`sameSite=lax`. |
| 3.5.5 | Prevent identifier reuse | | ✅ | ✅ | Product | Shipped | User IDs are random (`usr_` + 72-bit random, `apps/web/src/lib/auth.ts`) and never recycled; an email already bound to a different SSO `sub` is refused rather than silently taken over. |
| 3.5.6 | Disable identifiers after inactivity | | ✅ | ✅ | Product | Partial | Admin-driven disable exists and takes effect immediately — a deactivated user's cookie is dead, not just their sign-in (`db/migrations/0035_app_user_disabled.sql`; `getCurrentUser` filters `disabled_at`). No *automatic* inactivity-based disable. |
| 3.5.7–3.5.9 | Password complexity / reuse / temporary passwords | | ✅ | ✅ | Shared | Partial | Delegated to the IdP under SSO. The local admin password (setup wizard) has no complexity/reuse enforcement in the product. |
| 3.5.10 | Cryptographically protected password/credential storage | | ✅ | ✅ | Product | Shipped | All stored credentials (tokens, keys, passwords) are encrypted at rest with AES-256-GCM `enc:v1` (`packages/secret-crypt/src/index.ts`, `apps/openneko/internal/config/crypt.go`, `SECRETS.md`); credentials are never typed into chat and never enter model context (`FEATURES.md` "Credentials stay out of chat"). |
| 3.5.11 | Obscure authentication feedback | | ✅ | ✅ | Product | Shipped | Plugin secret prompts use hidden input at the CLI (`PLUGINS.md`); browser password fields mask input. |

## Media Protection (MP) — technical subset

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.8.3 | Sanitize media before disposal/reuse | ✅ | ✅ | ✅ | Deployment | Inherited | Physical media handling is the operator's. Product-side note: all state lives in one Postgres + one secrets file, so the surface to sanitize is small and known (`README.md` "single Postgres"). |
| 3.8.6 | Encrypt CUI on media during transport | | ✅ | ✅ | Deployment | Inherited | Backup transport is the operator's; encrypting backups at rest is theirs too (see 3.8.9). |
| 3.8.7 | Control removable media | | ✅ | ✅ | Deployment | Inherited | Host/endpoint control. |
| 3.8.9 | Protect confidentiality of backup CUI | | ✅ | ✅ | Shared | Partial | Secrets inside any backup are already ciphertext (`enc:v1`, `packages/secret-crypt`); business data in Postgres dumps is plaintext — the operator must encrypt backups. |

## Maintenance (MA) / Risk Assessment (RA) — technical subset

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.7.5 | MFA for nonlocal maintenance | | ✅ | ✅ | Deployment | Inherited | SSH/remote administration of the host is outside the product. |
| 3.11.2 | Vulnerability scanning | | ✅ | ✅ | Shared | Gap | No dependency/image scanning in CI today (`.github/workflows/` has build/test/release/smoke but no CodeQL, Trivy, or audit step). Deployment-side host scanning is the operator's. **Action: add dependency + container scanning to `pr-checks.yml`.** |
| 3.11.3 | Remediate vulnerabilities | | ✅ | ✅ | Shared | Partial | Fast remediation path exists — zero-click release pipeline, smoke-gated deploys, auto-upgrading plugins (`FEATURES.md` "Releases that gate themselves", "Always-current integrations") — but without 3.11.2 scanning there's no systematic detection feeding it. |

## System & Communications Protection (SC)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.13.1 | Boundary protection | ✅ | ✅ | ✅ | Product | Shipped | Every untrusted component (agent, each plugin) sits behind its own default-deny sandbox boundary; the only trusted control plane is the worker/web process (`OPENSHELL.md` architecture). External perimeter (firewall/proxy) is the deployment's. |
| 3.13.3 | Separate user functionality from system management | | ✅ | ✅ | Product | Shipped | Control plane (DB, secrets, policy, approvals) is physically separated from the agent runtime: `runChatTurn` splits into host-side prologue/epilogue and sandboxed `runCore` (`OPENSHELL.md`, `packages/llm/src/work/`). |
| 3.13.4 | Prevent unauthorized info transfer via shared resources | | ✅ | ✅ | Product | Shipped | Per-plugin isolated microVMs; per-operator OAuth tokens are stored per-person and injected per invocation, never shared (`PLUGINS.md` "Per-person integrations", `FEATURES.md`). |
| 3.13.5 | Subnetworks for publicly accessible components | ✅ | ✅ | ✅ | Deployment | Inherited | OpenNeko is not designed to be public-facing; exposure topology (DMZ, reverse proxy) is the operator's. |
| 3.13.6 | Deny-all, permit-by-exception network traffic | | ✅ | ✅ | Product | Shipped | Literally the sandbox egress model: default-deny, allowed per `(host, binary)` for the agent and per manifest for plugins (`OPENSHELL.md` "Egress is default-deny"). |
| 3.13.7 | Prevent split tunneling | | ✅ | ✅ | Deployment | Inherited | Endpoint/VPN configuration. |
| 3.13.8 | Encrypt CUI in transit | | ✅ | ✅ | Shared | Partial | Model/plugin egress is HTTPS; the OpenShell gateway uses mTLS internally (`OPENSHELL.md` Deployment). The web UI itself serves HTTP on localhost — remote access requires the operator's TLS reverse proxy. |
| 3.13.9 | Terminate connections after session end | | ✅ | ✅ | Product | Shipped | Sessions carry a hard 12 h expiry and are invalidated on logout, user disable, or secret rotation (`apps/web/src/lib/auth.ts`). |
| 3.13.10 | Cryptographic key management | | ✅ | ✅ | Product | Shipped | Local key: auto-generated 32-byte key at `~/.config/openneko/secret-key`, mode 0600 (`packages/secret-crypt/src/index.ts`); enterprise: external Infisical vault with short-TTL refresh so rotation lands without restart (`SECRETS.md`); DB password rotation propagates across seeds/gateway/agent (`FEATURES.md` #121/#125). |
| 3.13.11 | FIPS-validated cryptography | | ✅ | ✅ | Product | Gap | Algorithms are FIPS-approved (AES-256-GCM, SHA-256, HMAC-SHA-256) but the crypto modules (Node `node:crypto`/OpenSSL as shipped, Go stdlib) are not FIPS-140-validated builds. Deployments requiring FIPS validation need FIPS-mode OpenSSL/BoringCrypto builds. |
| 3.13.12 | Control collaborative computing devices | | ✅ | ✅ | N/A | N/A | No camera/mic surface. |
| 3.13.13 | Control and monitor mobile code | | ✅ | ✅ | Product | Shipped | The mobile-code problem *is* the product's core threat model: LLM-generated behavior and third-party plugin code always execute inside policy sandboxes — there is no unsandboxed mode (`OPENSHELL.md`); untrusted community skill shell blocks can be wrapped in one-shot microVMs (`PLUGINS.md` `allowSandboxedSkillEscape`). |
| 3.13.14 | Control VoIP | | ✅ | ✅ | N/A | N/A | No VoIP surface. |
| 3.13.15 | Protect authenticity of communication sessions | | ✅ | ✅ | Product | Shipped | HMAC-SHA-256-signed session cookies with constant-time comparison (`apps/web/src/lib/auth.ts`); mTLS between gateway components (`OPENSHELL.md`); signed single-use OIDC state. |
| 3.13.16 | Protect CUI at rest | | ✅ | ✅ | Shared | Partial | All secrets/credentials are AES-256-GCM at rest (`packages/secret-crypt`, `SECRETS.md`, `db/migrations/0047_data_source_secret.sql`). Business data in Postgres is not application-layer encrypted — use disk/volume encryption or Postgres TDE at the deployment layer. |

## System & Information Integrity (SI)

| Control | Technical requirement | L1 | L2 | L3 | Applicability | Status | Rationale / evidence |
|---|---|:-:|:-:|:-:|---|---|---|
| 3.14.1 | Identify and correct system flaws | ✅ | ✅ | ✅ | Product | Shipped | Zero-click release pipeline with post-release smoke gating — broken releases auto-demote so installers always get the last good version (`.github/workflows/release-please.yml`, `post-release-smoke.yml`, `deploy.yml`; `FEATURES.md`); installed plugins auto-upgrade to latest marketplace release on deploy. |
| 3.14.2 / 3.14.4 / 3.14.5 | Anti-malware protection, updates, scanning | ✅ | ✅ | ✅ | Deployment | Inherited | Host-level EDR/AV is the operator's. Product-side compensation: all untrusted code executes in microVMs regardless of source (`PLUGINS.md` "The sandbox enforces capability declarations regardless of source"). |
| 3.14.6 | Monitor systems and traffic for attacks | | ✅ | ✅ | Product | Shipped | Behavioral threshold monitoring on the agent: control-plane call rates per run, action requests/hour, memory writes/hour raise `behavior_alert` rows and dispatch `security.behavior_threshold` events for paging (`packages/llm/src/work/behavior-monitor.ts`, `db/migrations/0043_behavior_alerts.sql`). Network IDS is the deployment's. |
| 3.14.7 | Identify unauthorized use | | ✅ | ✅ | Product | Shipped | Dual-identity audit means no anonymous privileged action (`0042_dual_identity_audit.sql`); behavior alerts flag activity outside the envelope; security profiles (solo/team/org/hardened) scale alarm sensitivity (`FEATURES.md` "Security profiles"). |

## Level 3 only — enhanced technical controls (NIST SP 800-172 subset)

| Control | Technical requirement | Applicability | Status | Rationale / evidence |
|---|---|---|---|---|
| AC 3.1.2e | Restrict CUI access to organization-controlled endpoints | Deployment | Inherited | Endpoint/NAC control. |
| AC 3.1.3e | Secure transfer between security domains | Shared | Partial | The gateway egress proxy is a controlled cross-domain transfer point: the sandbox↔model boundary strips/injects credentials on the wire (`OPENSHELL.md`). Broader cross-domain solutions are the deployment's. |
| CM 3.4.1e | Verify integrity/authenticity of critical software | Product | Shipped | Installer fetches checksum-verified release binaries (`README.md` Quickstart); marketplace plugin versions carry integrity hashes verified at install (`packages/plugin-install/src/manifest.ts`, `run-install.ts`); releases only deploy after passing smoke (`FEATURES.md`). |
| CM 3.4.2e | Automated detection/response to misconfigured or unauthorized components | Product | Partial | `openneko doctor`/`status` probe what's actually serving (`FEATURES.md` "Honest status"); policy changes automatically flag non-conforming installed plugins for removal (`PLUGINS.md`). No continuous drift detection for host config. |
| CM 3.4.3e | Automated asset inventory | Shared | Partial | Plugin registry self-reconciles from `openneko.plugins.json` with hot reload (`PLUGINS.md`); container inventory is declared in compose. Full-environment asset discovery is the deployment's. |
| IA 3.5.1e | Bidirectional cryptographic authentication between components | Product | Partial | mTLS between the OpenShell gateway and its clients; per-sandbox JWTs authenticate sandboxes to the gateway (`OPENSHELL.md` Deployment). Not yet universal across every internal hop (worker admin endpoint relies on loopback isolation). |
| IA 3.5.3e | Block untrusted assets from connecting | Deployment | Inherited | NAC is network infrastructure. |
| RA 3.11.2e | Threat hunting with threat intelligence | Deployment | Inherited | Organizational capability; the exportable audit chain and behavior alerts are the product's food for it. |
| SC 3.13.4e | Physical/logical isolation techniques | Product | Shipped | Per-component microVM isolation is the architecture: agent and every plugin in separate sandboxes, control plane outside, key material excluded from the box and verifiably absent (`OPENSHELL.md` "Verifying key isolation"). |
| SI 3.14.1e | Root-of-trust integrity verification of critical software | Product | Partial | Checksums verify releases and plugin packages at install; no hardware root-of-trust / signed-boot chain (deployment hardware concern). |
| SI 3.14.2e | Behavioral/anomaly monitoring of users and components | Product | Shipped | Purpose-built: behavior sweeps over the audit stream with per-(kind, subject) deduped alerts (`packages/llm/src/work/behavior-monitor.ts`); memory integrity sealing + TTL prevents poisoned/stale memories steering the agent (`db/migrations/0041_memory_integrity_ttl.sql`; `FEATURES.md` "Memory integrity"). |
| SI 3.14.3e | Integrity-check executables/libraries before execution | Product | Partial | Integrity verified at install time (plugins) and download time (binaries); no re-verification at each execution. Sandboxing bounds the blast radius of a tampered artifact. |
| SI 3.14.6e | Use threat indicators in detection | Deployment | Inherited | IOC feeds/SIEM integration is the SOC's; the hash-chained audit log exports into those tools (`FEATURES.md`). |

---

## Summary of open product gaps

Tracked here so the table above stays honest:

1. **3.1.8 / 3.1.9** — no logon attempt limiting or configurable banner on the local sign-in path.
2. **3.5.1 / 3.5.3 / 3.5.7–3.5.9 (local mode)** — the shared-admin-password mode has no per-user identity, MFA, or password policy; CUI-scoped deployments must run with an SSO auth plugin and enforce MFA at the IdP.
3. **3.1.11 / 3.1.10** — no idle timeout distinct from the 12 h absolute session TTL.
4. **3.11.2** — no dependency/container vulnerability scanning in CI; add to `pr-checks.yml`.
5. **3.13.8** — web UI needs a fronting TLS proxy for any non-localhost access; document a reference config.
6. **3.13.11** — crypto modules are not FIPS-140-validated builds (algorithms are FIPS-approved).
7. **3.13.16** — business data in Postgres relies on deployment-layer encryption at rest.
8. **3.3.4** — audit-chain gaps are detected on verification, not alerted in real time.

*Last reviewed: 2026-07-13. CMMC references: 32 CFR Part 170; NIST SP 800-171 Rev 2; NIST SP 800-172.*
