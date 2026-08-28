import { mkdir, chmod } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { and, data_source, db, desc, eq, like, llm_provider_config, or } from "@neko/db";
import { maybeDecryptSecret } from "./secrets";
import { VENDORED_HERMES_MODEL_BINARY } from "./agent-runtime-contract";
import { hermesHomeForOrg } from "./hermes-home";
import {
  ensureOpenShellProvider,
  verifyOpenShellGateway,
} from "./work/sandbox-launcher";

const HERMES_DEFAULT_MAX_TURNS = 25;
const HERMES_DELEGATION_DEFAULT_MAX_ITERATIONS = 50;
const HERMES_DELEGATION_DEFAULT_MAX_CONCURRENT_CHILDREN = 3;
const HERMES_DELEGATION_DEFAULT_MAX_SPAWN_DEPTH = 1;
const HERMES_DELEGATION_DEFAULT_CHILD_TIMEOUT_SECONDS = 0;

type StoredRow = {
  provider: string;
  model: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
  secrets: Record<string, unknown> | null;
};

async function loadProviderRow(
  orgId: string,
  scope: string,
): Promise<StoredRow | null> {
  try {
    const rows = await db()
      .select({
        provider: llm_provider_config.provider,
        model: llm_provider_config.model,
        enabled: llm_provider_config.enabled,
        config: llm_provider_config.config,
        secrets: llm_provider_config.secrets,
      })
      .from(llm_provider_config)
      .where(
        and(
          eq(llm_provider_config.org_id, orgId),
          eq(llm_provider_config.scope, scope),
        ),
      )
      .limit(1);
    return (rows[0] as StoredRow | undefined) ?? null;
  } catch {
    return null;
  }
}

function getHome(): string {
  return process.env.HOME || homedir();
}

function graphjinConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return join(xdg, "graphjin", "client.json");
  }
  if (platform() === "darwin") {
    return join(getHome(), "Library", "Application Support", "graphjin", "client.json");
  }
  return join(getHome(), ".config", "graphjin", "client.json");
}

function deriveServerBase(graphqlUrl: string): string | null {
  try {
    const u = new URL(graphqlUrl);
    if (u.pathname.endsWith("/api/v1/graphql")) {
      return `${u.origin}${u.pathname.slice(0, -"/api/v1/graphql".length)}`;
    }
    return u.origin;
  } catch {
    return null;
  }
}

async function provisionGraphJin(orgId: string): Promise<void> {
  const rows = await db()
    .select({ graphql_url: data_source.graphql_url })
    .from(data_source)
    .where(eq(data_source.org_id, orgId))
    .orderBy(desc(data_source.is_default), data_source.created_at)
    .limit(1);
  const url = rows[0]?.graphql_url;
  if (!url) return;

  const server = deriveServerBase(url);
  if (!server) return;

  const path = graphjinConfigPath();
  await mkdir(join(path, ".."), { recursive: true });
  await atomicWriteFile(
    path,
    JSON.stringify(
      { server, token: "", expires_at: "0001-01-01T00:00:00Z" },
      null,
      2,
    ),
  );
}

export {
  SOURCES_SECRET_PLACEHOLDER,
  SOURCES_JWT_SECRET_RE,
  LEGACY_PACKAGED_DEMO_GRAPHJIN_CONFIG,
  migrateGraphjinSystemSource,
  patchGraphjinSourcesJwtSecret,
  shouldReconcileDemoSourceAuthMode,
} from "./graphjin/sources-config";
import {
  atomicWriteFile,
  migrateGraphjinSystemSource,
  patchGraphjinSourcesJwtSecret,
  shouldReconcileDemoSourceAuthMode,
  reconcileGraphjinWritePolicy,
} from "./graphjin/sources-config";

/**
 * Sources-mode (agentic) bootstrap. Two halves, both idempotent:
 *
 * 1. When the deployment mounts the GraphJin config into the worker
 *    (OPENNEKO_GRAPHJIN_CONFIG, the demo compose does), ensure the
 *    per-org JWT secret in the seeded template matches this install's
 *    secret-key. Named local volumes can outlive a secret-key rotation,
 *    so this repairs stale concrete secrets as well as placeholders.
 *
 * 2. The packaged demo is known to run this JWT template, so reconcile its
 *    AdventureWorks row directly (including upgrades driven by the older
 *    v2.25 CLI). Other modes keep capability detection: probe the default
 *    source with a service token and only flip auth_mode to 'jwt' when it
 *    answers gj_catalog. Legacy servers remain 'none'.
 */
async function provisionGraphjinSourcesMode(orgId: string): Promise<void> {
  const cfgPath = process.env.OPENNEKO_GRAPHJIN_CONFIG?.trim();
  let wroteConfig = false;
  let reconcileDemoAuthMode = false;
  if (cfgPath) {
    const { readFile } = await import("node:fs/promises");
    try {
      const raw = await readFile(cfgPath, "utf8");
      const { graphjinSigningSecretB64 } = await import("./graphjin/token");
      const migrated = migrateGraphjinSystemSource(raw);
      const patched = patchGraphjinSourcesJwtSecret(
        migrated.content,
        graphjinSigningSecretB64(orgId),
      );
      const policy = reconcileGraphjinWritePolicy(patched.content);
      reconcileDemoAuthMode = shouldReconcileDemoSourceAuthMode(
        cfgPath,
        policy.content,
        process.env.OPENNEKO_STACK_MODE,
      );
      if (migrated.changed || patched.changed || policy.changed) {
        await atomicWriteFile(cfgPath, policy.content);
        wroteConfig = true;
        console.log(
          `[host-provision] reconciled GraphJin agentic config in ${cfgPath}`,
        );
      }
    } catch (e) {
      console.warn(
        `[host-provision] GraphJin agentic config reconciliation failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  const [src] = await db()
    .select({
      id: data_source.id,
      authMode: data_source.auth_mode,
      graphqlUrl: data_source.graphql_url,
    })
    .from(data_source)
    .where(
      reconcileDemoAuthMode
        ? and(
            eq(data_source.org_id, orgId),
            // The seeded label ("AdventureWorks") is renamed by the setup
            // wizard's data-source save, which permanently disabled this
            // reconcile. The in-stack customer GraphJin URL is the stable
            // identity of the packaged demo's source, so match either.
            or(
              eq(data_source.label, "AdventureWorks"),
              like(data_source.graphql_url, "http://graphjin:8080/%"),
            ),
          )
        : eq(data_source.org_id, orgId),
    )
    .orderBy(desc(data_source.is_default), data_source.created_at)
    .limit(1);
  if (!src?.graphqlUrl) return;
  let authMode = src.authMode;
  if (reconcileDemoAuthMode && authMode !== "jwt") {
    await db()
      .update(data_source)
      .set({ auth_mode: "jwt", updated_at: new Date() })
      .where(eq(data_source.id, src.id));
    authMode = "jwt";
    console.log(
      "[host-provision] reconciled packaged demo data source auth_mode=jwt",
    );
  }
  if (authMode === "jwt" && !wroteConfig) return;

  const { mintGraphjinToken } = await import("./graphjin/token");
  const token = mintGraphjinToken({ orgId, userId: null, role: "service" });
  // Only when WE just changed the config does the server need a reload
  // window (reload_on_config_change, observed ~10s on 3.18.37). An
  // in-stack GraphJin may simply still be starting alongside us, so give
  // it a few short attempts; an unmanaged external or legacy endpoint
  // gets a single quick probe — an unreachable one must not stall boot.
  const inStackGraphjin = /^https?:\/\/(graphjin|neko-graphjin|records-graphjin)[:/]/.test(
    src.graphqlUrl,
  );
  const maxAttempts = wroteConfig ? 6 : inStackGraphjin ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(src.graphqlUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: `query { gj_catalog(id: "help:discovery") { id } }`,
        }),
        signal: AbortSignal.timeout(2_500),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { gj_catalog?: unknown };
          errors?: unknown[];
        };
        // gj_catalog(id:) returns one object; list queries an array.
        const rows = body.data?.gj_catalog;
        const answered = Array.isArray(rows) ? rows.length > 0 : Boolean(rows);
        if (answered && !body.errors?.length) {
          if (authMode !== "jwt") {
            await db()
              .update(data_source)
              .set({ auth_mode: "jwt", updated_at: new Date() })
              .where(eq(data_source.id, src.id));
            console.log(
              `[host-provision] data source answers gj_catalog with an actor token — auth_mode=jwt (agentic mode on)`,
            );
          }
          return;
        }
      }
    } catch {
      // unreachable / not reloaded yet — retry below.
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 3000));
  }
}

function mapHermesProvider(neko: string): {
  provider: string;
  keyVar: string;
  needsBaseUrl: boolean;
} {
  switch (neko) {
    case "anthropic":
      return { provider: "anthropic", keyVar: "ANTHROPIC_API_KEY", needsBaseUrl: false };
    case "openai":
      return { provider: "openai", keyVar: "OPENAI_API_KEY", needsBaseUrl: false };
    case "openrouter":
      return { provider: "openrouter", keyVar: "OPENROUTER_API_KEY", needsBaseUrl: false };
    case "google-gemini":
      return { provider: "gemini", keyVar: "GEMINI_API_KEY", needsBaseUrl: false };
    case "vertex":
      return { provider: "custom", keyVar: "OPENAI_API_KEY", needsBaseUrl: true };
    case "x-grok":
      return { provider: "openrouter", keyVar: "OPENROUTER_API_KEY", needsBaseUrl: false };
    case "ollama":
    case "azure-openai":
      return {
        provider: "custom",
        keyVar: `${neko.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        needsBaseUrl: true,
      };
    default:
      return {
        provider: neko,
        keyVar: `${neko.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        needsBaseUrl: false,
      };
  }
}

function decryptSecrets(secrets: Record<string, unknown> | null): Record<string, string> {
  if (!secrets) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(secrets)) {
    const decrypted = maybeDecryptSecret(v);
    if (decrypted) out[k] = decrypted;
  }
  return out;
}

export { hermesHomeForOrg } from "./hermes-home";

function readIntEnv(
  name: string,
  fallback: number,
  opts: { min: number; max?: number },
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  if (n < opts.min) return opts.min;
  if (opts.max !== undefined && n > opts.max) return opts.max;
  return n;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export { VENDORED_HERMES_MODEL_BINARY } from "./agent-runtime-contract";

function hermesDelegationConfigLines(): string[] {
  const maxIterations = readIntEnv(
    "OPENNEKO_AGENT_DELEGATION_MAX_ITERATIONS",
    HERMES_DELEGATION_DEFAULT_MAX_ITERATIONS,
    { min: 1 },
  );
  const maxConcurrentChildren = readIntEnv(
    "OPENNEKO_AGENT_DELEGATION_MAX_CONCURRENT_CHILDREN",
    HERMES_DELEGATION_DEFAULT_MAX_CONCURRENT_CHILDREN,
    { min: 1 },
  );
  const maxSpawnDepth = readIntEnv(
    "OPENNEKO_AGENT_DELEGATION_MAX_SPAWN_DEPTH",
    HERMES_DELEGATION_DEFAULT_MAX_SPAWN_DEPTH,
    { min: 1, max: 3 },
  );
  const childTimeoutSeconds = readIntEnv(
    "OPENNEKO_AGENT_DELEGATION_CHILD_TIMEOUT_SECONDS",
    HERMES_DELEGATION_DEFAULT_CHILD_TIMEOUT_SECONDS,
    { min: 0 },
  );
  const orchestratorEnabled = readBoolEnv(
    "OPENNEKO_AGENT_DELEGATION_ORCHESTRATOR_ENABLED",
    true,
  );

  return [
    "delegation:",
    `  max_iterations: ${maxIterations}`,
    `  max_concurrent_children: ${maxConcurrentChildren}`,
    `  max_spawn_depth: ${maxSpawnDepth}`,
    `  orchestrator_enabled: ${orchestratorEnabled ? "true" : "false"}`,
    `  child_timeout_seconds: ${childTimeoutSeconds}`,
  ];
}

async function provisionHermes(orgId: string): Promise<void> {
  const row = await loadProviderRow(orgId, "primary");
  if (!row || !row.enabled) return;

  const { provider, keyVar, needsBaseUrl } = mapHermesProvider(row.provider);
  const cfg = (row.config ?? {}) as { url?: string; baseUrl?: string };
  const baseUrl = cfg.baseUrl || cfg.url;
  const secrets = decryptSecrets(row.secrets);
  const apiKey = secrets.apiKey;
  const model = row.model ?? "";

  const hermesHome = hermesHomeForOrg(orgId);
  await mkdir(hermesHome, { recursive: true });

  const yamlLines = [
    "model:",
    `  default: "${escapeYamlString(model)}"`,
    `  provider: "${provider}"`,
  ];
  if (baseUrl) yamlLines.push(`  base_url: "${escapeYamlString(baseUrl)}"`);
  if (provider === "custom" && needsBaseUrl && !baseUrl) {
    console.warn(
      `[host-provision] hermes: provider=custom but no base_url for ${row.provider}; user must add it in /admin/settings/agent`,
    );
  }
  yamlLines.push("");
  yamlLines.push("agent:");
  yamlLines.push(`  max_turns: ${HERMES_DEFAULT_MAX_TURNS}`);
  yamlLines.push("");
  yamlLines.push(...hermesDelegationConfigLines());
  yamlLines.push("");

  await atomicWriteFile(join(hermesHome, "config.yaml"), yamlLines.join("\n"));

  const envContent = apiKey ? `${keyVar}=${apiKey}\n` : "";
  await atomicWriteFile(join(hermesHome, ".env"), envContent, { mode: 0o600 });
  await chmod(join(hermesHome, ".env"), 0o600);
}

function escapeYamlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// API host per neko model-provider when there's no explicit base_url. A handful
// of providers (NOT the 300 model variants) — derived from the org's config,
// never hand-set per deployment.
const PROVIDER_API_HOSTS: Record<string, string> = {
  "google-gemini": "generativelanguage.googleapis.com",
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  openrouter: "openrouter.ai",
  "x-grok": "openrouter.ai",
};

/**
 * Derive the agent-sandbox egress from the org's model config: the API host
 * (explicit base_url, else the provider default) + models.dev for hermes model
 * resolution; the exact connecting binary (egress matches /proc/<pid>/exe);
 * and the env var the backend reads.
 */
function deriveAgentEgress(
  row: StoredRow,
): { hosts: string[]; keyEnv: string } {
  const cfg = (row.config ?? {}) as { url?: string; baseUrl?: string };
  const baseUrl = cfg.baseUrl || cfg.url;
  let host: string | undefined;
  if (baseUrl) {
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* fall through to the provider default */
    }
  }
  host ??= PROVIDER_API_HOSTS[row.provider];
  return {
    hosts: [...(host ? [host] : []), "models.dev"],
    keyEnv: mapHermesProvider(row.provider).keyVar,
  };
}

/**
 * Self-configure the agent sandbox from the org's model config — derive the
 * egress (host/key-env; explicit env overrides win) and sync the
 * model key into a gateway-side provider so the proxy injects it on the
 * wire (the key never enters the box). Replaces the manual `openshell
 * provider create` + hand-set egress env.
 */
// Operator-supplied provider/host/key/home values win permanently; empty or
// unset means "derive from the org's provider config". The model executable is
// intentionally absent: it is a vendored runtime contract, never an operator
// setting. Values here are snapshotted at module load,
// BEFORE any provisioning pass mutates process.env — the previous `||=`
// writes made the FIRST pass's derived values permanent, so a provider
// switch left the sandbox egress allowlist and key env var pinned to the old
// provider until the process restarted.
const OPERATOR_AGENT_ENV = {
  provider: process.env.OPENNEKO_AGENT_MODEL_PROVIDER || "",
  host: process.env.OPENNEKO_AGENT_MODEL_HOST || "",
  keyEnv: process.env.OPENNEKO_AGENT_MODEL_KEY_ENV || "",
  hermesHome: process.env.OPENNEKO_AGENT_HERMES_HOME || "",
};

function setAgentEnv(key: string, operator: string, derived: string): void {
  const value = operator || derived;
  if (value) process.env[key] = value;
  else delete process.env[key];
}

async function provisionOpenShellRuntime(orgId: string): Promise<void> {
  const row = await loadProviderRow(orgId, "primary");
  if (!row || !row.enabled) return;

  const { hosts, keyEnv } = deriveAgentEgress(row);
  setAgentEnv("OPENNEKO_AGENT_MODEL_PROVIDER", OPERATOR_AGENT_ENV.provider, "openneko-agent");
  setAgentEnv("OPENNEKO_AGENT_MODEL_HOST", OPERATOR_AGENT_ENV.host, hosts.join(","));
  setAgentEnv("OPENNEKO_AGENT_MODEL_KEY_ENV", OPERATOR_AGENT_ENV.keyEnv, keyEnv);
  // hermes reads its model + provider from config.yaml under HERMES_HOME. In the
  // sandbox that config must be MIRRORED in — the launcher does so when
  // OPENNEKO_AGENT_HERMES_HOME points at the host home provisionHermes writes.
  // Without it, in-box hermes finds no config and silently falls back to a
  // default model that 404s.
  setAgentEnv(
    "OPENNEKO_AGENT_HERMES_HOME",
    OPERATOR_AGENT_ENV.hermesHome,
    hermesHomeForOrg(orgId),
  );

  const apiKey = decryptSecrets(row.secrets).apiKey;
  if (!apiKey) return;
  // The gateway can be restarting exactly while we register the provider
  // (deploys recreate it alongside the worker). A single failed attempt
  // used to be swallowed upstream, leaving a healthy worker with no
  // provider on the gateway and every channel run broken until a restart.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureOpenShellProvider({
        providerName: process.env.OPENNEKO_AGENT_MODEL_PROVIDER ?? "openneko-agent",
        apiKey,
        gatewayName: process.env.OPENSHELL_GATEWAY || undefined,
        gatewayEndpoint: process.env.OPENSHELL_GATEWAY_ENDPOINT || undefined,
      });
      lastError = undefined;
      break;
    } catch (e) {
      lastError = e;
      if (attempt < 3) {
        console.warn(
          `[host-provision] OpenShell provider sync attempt ${attempt} failed; retrying: ${e instanceof Error ? e.message : e}`,
        );
        const base = Number(process.env.OPENNEKO_PROVISION_RETRY_BASE_MS ?? 2_000);
        await new Promise((resolve) => setTimeout(resolve, attempt * base));
      }
    }
  }
  if (lastError !== undefined) throw lastError;
  console.log(
    `[host-provision] OpenShell agent runtime self-configured: provider="${process.env.OPENNEKO_AGENT_MODEL_PROVIDER}" egress="${hosts.join(",")}" binary="${VENDORED_HERMES_MODEL_BINARY}" keyEnv=${keyEnv}`,
  );
}

/**
 * Readiness gate for any operation that is about to launch an agent sandbox.
 * This deliberately performs a fresh gateway RPC instead of consulting a
 * process-local flag: the gateway may have failed or been omitted from a
 * Compose invocation after the web/worker process itself became healthy.
 *
 * Once connectivity is proven, re-sync the org's model provider so the exact
 * path onboarding will use is configured before work is enqueued.
 */
export async function verifyAgentRuntimeReady(orgId: string): Promise<void> {
  await verifyOpenShellGateway({
    gatewayName: process.env.OPENSHELL_GATEWAY || undefined,
    gatewayEndpoint: process.env.OPENSHELL_GATEWAY_ENDPOINT || undefined,
  });
  await provisionOpenShellRuntime(orgId);
}

const provisionedOrgs = new Map<string, Promise<void>>();

type ProvisionHostConfigOptions = {
  requireOpenShellSync?: boolean;
};

/**
 * provisionHostConfig, once per org per process. The worker provisions at
 * boot, but the web process used to derive the agent-sandbox env (model
 * egress, gateway provider, key alias) only on a settings save — so every
 * web restart silently launched sandboxes that couldn't reach the model
 * until someone re-saved settings. Run paths call this instead.
 */
export function ensureHostConfigProvisioned(orgId: string): Promise<void> {
  let p = provisionedOrgs.get(orgId);
  if (!p) {
    p = provisionHostConfig(orgId, { requireOpenShellSync: true }).catch((err) => {
      provisionedOrgs.delete(orgId);
      throw err;
    });
    provisionedOrgs.set(orgId, p);
  }
  return p;
}

export async function provisionHostConfig(
  orgId: string,
  options: ProvisionHostConfigOptions = {},
): Promise<void> {
  try {
    await provisionGraphJin(orgId);
  } catch (e) {
    console.warn(
      `[host-provision] graphjin write failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    await provisionGraphjinSourcesMode(orgId);
  } catch (e) {
    console.warn(
      `[host-provision] sources-mode provision failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  let openShellError: unknown;
  try {
    await provisionOpenShellRuntime(orgId);
  } catch (e) {
    openShellError = e;
    console.warn(
      `[host-provision] OpenShell runtime provision failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  try {
    await provisionHermes(orgId);
  } catch (e) {
    console.warn(
      `[host-provision] hermes write failed: ${e instanceof Error ? e.message : e}`,
    );
  }

  if (openShellError && options.requireOpenShellSync) {
    throw openShellError;
  }
}
