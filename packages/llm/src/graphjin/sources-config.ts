import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

/**
 * Pure helpers for the GraphJin sources-mode (agentic) config file.
 *
 * Kept isolated from the worker dependency graph on purpose: the one-shot
 * graphjin-secret-init container patches this file BEFORE GraphJin's first
 * start and needs only the YAML parser plus Node built-ins. host-provision.ts
 * re-exports these helpers so existing imports keep working.
 */

export const SOURCES_SECRET_PLACEHOLDER = "REPLACE_WITH_PER_ORG_SECRET_B64";
export const SOURCES_JWT_SECRET_RE =
  /(^auth:\s*\n\s+type:\s*jwt\s*\n\s+jwt:\s*\n(?:\s+#.*\n)*\s+secret:\s*")([^"]*)(")/m;
export const LEGACY_PACKAGED_DEMO_GRAPHJIN_CONFIG = "/graphjin-config/agentic.yml";

const AGENTIC_SYSTEM_CAPABILITIES = {
  "catalog.read": true,
  "security.read": true,
  "config.read": true,
  "config.write": true,
  "runtime.read": true,
  "raw_graphql.query": true,
  "raw_graphql.mutate": false,
  "schema.reload": false,
  "schema.write": false,
  "dev_tools.read": false,
  "legacy_discovery.read": false,
};

const AGENTIC_SYSTEM_ROOT_ACCESS = {
  gj_catalog: "authenticated",
  gj_config: "admin",
  gj_security: "admin",
  gj_runtime: "admin",
};

/**
 * GraphJin 3.20 moved its catalog/config/security/runtime roots out of the
 * synthetic `sources[].kind: graphjin` provider and into top-level `system`.
 * Config volumes survive image upgrades, so a corrected seed alone cannot
 * repair an existing install. Migrate that one removed provider in place,
 * retaining every real customer source and any already-explicit system value.
 */
export function migrateGraphjinSystemSource(
  raw: string,
): { content: string; changed: boolean } {
  const document = parseDocument(raw);
  if (document.errors.length > 0) {
    throw new Error(`GraphJin config is not valid YAML: ${document.errors[0].message}`);
  }
  if (!isMap(document.contents)) {
    throw new Error("GraphJin config root must be a YAML object");
  }

  const sources = document.get("sources", true);
  if (sources == null) return { content: raw, changed: false };
  if (!isSeq(sources)) {
    throw new Error("GraphJin config sources must be a YAML list");
  }

  const legacySources = sources.items.filter(
    (source) =>
      isMap(source) &&
      String(source.get("kind") ?? "").trim().toLowerCase() === "graphjin",
  );
  if (legacySources.length === 0) return { content: raw, changed: false };

  sources.items = sources.items.filter((source) => !legacySources.includes(source));

  let system = document.get("system", true);
  if (system == null) {
    document.set(
      "system",
      document.createNode({
        capabilities: AGENTIC_SYSTEM_CAPABILITIES,
        root_access: AGENTIC_SYSTEM_ROOT_ACCESS,
      }),
    );
    system = document.get("system", true);
  }
  if (!isMap(system)) {
    throw new Error("GraphJin config system must be a YAML object");
  }

  for (const [sectionName, defaults] of [
    ["capabilities", AGENTIC_SYSTEM_CAPABILITIES],
    ["root_access", AGENTIC_SYSTEM_ROOT_ACCESS],
  ] as const) {
    let section = system.get(sectionName, true);
    if (section == null) {
      system.set(sectionName, document.createNode(defaults));
      section = system.get(sectionName, true);
    }
    if (!isMap(section)) {
      throw new Error(`GraphJin config system.${sectionName} must be a YAML object`);
    }
    for (const [key, value] of Object.entries(defaults)) {
      if (section.get(key, true) == null) section.set(key, value);
    }
  }

  return { content: document.toString(), changed: true };
}

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
