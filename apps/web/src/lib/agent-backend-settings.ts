import "server-only";

import { and, db, eq, llm_provider_config } from "@neko/db";
import {
  AGENT_BACKEND_OPTIONS,
  AGENT_DEFAULT_GLOBAL_CAP,
} from "@neko/llm";

const AGENT_SCOPE = "agent";
export type AgentSettings = {
  source: "org" | "default";
  /** Compatibility field for pre-Hermes-only setup clients. */
  backend: "hermes";
  globalCap: number;
};

export type AgentSettingsPayload = {
  agent: AgentSettings;
  /** Compatibility list for pre-Hermes-only setup clients. */
  options: typeof AGENT_BACKEND_OPTIONS;
  defaults: {
    globalCap: number;
  };
};

async function loadAgentRow(orgId: string): Promise<{
  id: string;
  config: Record<string, unknown> | null;
} | null> {
  const rows = await db()
    .select({
      id: llm_provider_config.id,
      config: llm_provider_config.config,
    })
    .from(llm_provider_config)
    .where(
      and(
        eq(llm_provider_config.org_id, orgId),
        eq(llm_provider_config.scope, AGENT_SCOPE),
      ),
    )
    .limit(1);
  return (
    (rows[0] as
      | { id: string; config: Record<string, unknown> | null }
      | undefined) ?? null
  );
}

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

export async function getAgentSettings(
  orgId: string,
): Promise<AgentSettings> {
  const row = await loadAgentRow(orgId);
  const cfg = (row?.config ?? {}) as {
    globalCap?: unknown;
  };
  const globalCap = readPositiveInt(cfg.globalCap, AGENT_DEFAULT_GLOBAL_CAP);
  return {
    source: row ? "org" : "default",
    backend: "hermes",
    globalCap,
  };
}

export async function getAgentSettingsPayload(
  orgId: string,
): Promise<AgentSettingsPayload> {
  const agent = await getAgentSettings(orgId);
  return {
    agent,
    options: AGENT_BACKEND_OPTIONS,
    defaults: {
      globalCap: AGENT_DEFAULT_GLOBAL_CAP,
    },
  };
}

export type AgentSaveDraft = {
  /** Accepted only as the legacy no-op value "hermes". */
  backend?: unknown;
  globalCap?: number | string;
};

export async function saveAgentSettingsDraft(
  orgId: string,
  draft: AgentSaveDraft,
): Promise<AgentSettings> {
  if (draft.backend !== undefined && draft.backend !== "hermes") {
    throw new Error(`Unsupported agent backend: ${String(draft.backend)}`);
  }
  const existing = await loadAgentRow(orgId);
  const existingCfg = (existing?.config ?? {}) as {
    globalCap?: unknown;
  };
  const globalCap = readPositiveInt(
    draft.globalCap ?? existingCfg.globalCap,
    AGENT_DEFAULT_GLOBAL_CAP,
  );
  const config = { globalCap };

  if (existing) {
    await db()
      .update(llm_provider_config)
      .set({
        provider: "hermes",
        config,
        updated_at: new Date(),
      })
      .where(eq(llm_provider_config.id, existing.id));
  } else {
    await db().insert(llm_provider_config).values({
      org_id: orgId,
      scope: AGENT_SCOPE,
      provider: "hermes",
      enabled: true,
      config,
      secrets: {},
    });
  }

  return { source: "org", backend: "hermes", globalCap };
}
