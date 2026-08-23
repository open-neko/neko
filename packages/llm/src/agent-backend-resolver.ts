/**
 * Per-org agent backend resolution.
 *
 * Hermes is the sole runtime. The agent row only stores concurrency settings;
 * provider credentials are provisioned independently for Hermes.
 */

import { and, db, eq, llm_provider_config } from "@neko/db";
import {
  AGENT_DEFAULT_GLOBAL_CAP,
  type AgentBackend,
  type AgentBackendId,
} from "./agent-backend";
import { makeAgentBackend } from "./agent-runtime";

type StoredRow = {
  provider: string;
  model: string | null;
  enabled: boolean;
  config: Record<string, unknown> | null;
  secrets: Record<string, unknown> | null;
};

async function loadRow(orgId: string, scope: string): Promise<StoredRow | null> {
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

export async function resolveAgentBackendId(orgId: string): Promise<AgentBackendId> {
  void orgId;
  return "hermes";
}

export type AgentConcurrency = {
  globalCap: number;
};

function readPositiveInt(
  raw: unknown,
  fallback: number,
  { min = 1, max = 1000 }: { min?: number; max?: number } = {},
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min || n > max) return fallback;
  return Math.floor(n);
}

/**
 * Resolves the agent's concurrency caps for this worker boot.
 *
 * Read order: DB (scope='agent') → default. The /admin/settings/agent UI is
 * the only source of truth.
 *
 * Note: pg-boss `batchSize` is fixed at `b.work()` time, so changes to
 * `globalCap` only take effect after the next worker restart.
 */
export async function resolveAgentConcurrency(orgId: string): Promise<AgentConcurrency> {
  const row = await loadRow(orgId, "agent");
  const cfg = (row?.config ?? {}) as { globalCap?: unknown };
  return {
    globalCap: readPositiveInt(cfg.globalCap, AGENT_DEFAULT_GLOBAL_CAP),
  };
}

/**
 * Construct a backend from already-resolved config — no DB. Used both by
 * resolveAgentBackend (host, after the DB read) and by the agent sandbox's
 * entry.ts (from the launcher-passed config, with a PLACEHOLDER apiKey — the
 * real key is injected by the OpenShell egress proxy, never in the sandbox).
 */
export async function resolveAgentBackend(orgId: string): Promise<AgentBackend> {
  return makeAgentBackend({ id: await resolveAgentBackendId(orgId) });
}
