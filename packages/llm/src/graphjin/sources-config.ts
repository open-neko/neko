import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Pure helpers for the GraphJin sources-mode (agentic) config file.
 *
 * Kept dependency-free on purpose: the one-shot graphjin-secret-init
 * container patches the per-org JWT secret with these BEFORE GraphJin's
 * first start, and must not drag the worker's whole dependency graph
 * (drizzle, the app schema, …) into that boot path. host-provision.ts
 * re-exports them so existing imports keep working.
 */

export const SOURCES_SECRET_PLACEHOLDER = "REPLACE_WITH_PER_ORG_SECRET_B64";
export const SOURCES_JWT_SECRET_RE =
  /(^auth:\s*\n\s+type:\s*jwt\s*\n\s+jwt:\s*\n(?:\s+#.*\n)*\s+secret:\s*")([^"]*)(")/m;
export const LEGACY_PACKAGED_DEMO_GRAPHJIN_CONFIG = "/graphjin-config/agentic.yml";

export function patchGraphjinSourcesJwtSecret(
  raw: string,
  secret: string,
): { content: string; changed: boolean } {
  let content = raw.replaceAll(SOURCES_SECRET_PLACEHOLDER, secret);
  if (content !== raw) return { content, changed: true };

  const match = SOURCES_JWT_SECRET_RE.exec(raw);
  if (!match || match[2] === secret) return { content: raw, changed: false };

  content = raw.replace(SOURCES_JWT_SECRET_RE, `$1${secret}$3`);
  return { content, changed: content !== raw };
}

/**
 * Existing v2.25 demo installs do not carry OPENNEKO_STACK_MODE because their
 * compose file is embedded in the older host CLI. The dedicated demo mount is
 * therefore retained as a backward-compatible discriminator. Production uses
 * /config/graphjin/agentic.yml and must keep its capability-probe behavior.
 */
export function shouldReconcileDemoSourceAuthMode(
  configPath: string | undefined,
  configContent: string,
  stackMode?: string,
): boolean {
  const isDemo =
    stackMode === "demo" || configPath === LEGACY_PACKAGED_DEMO_GRAPHJIN_CONFIG;
  return isDemo && SOURCES_JWT_SECRET_RE.test(configContent);
}

/**
 * Write-then-rename within the target directory. GraphJin watches these
 * files (reload_on_config_change) and other processes read them on their
 * own schedule; an in-place truncate-and-write exposes a partial file to
 * both. rename(2) within one volume is atomic, so readers see either the
 * old content or the new — never a truncated intermediate.
 */
export async function atomicWriteFile(
  path: string,
  content: string,
  opts?: { mode?: number },
): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}`,
  );
  await writeFile(tmp, content, { encoding: "utf8", mode: opts?.mode ?? 0o664 });
  await rename(tmp, path);
}
