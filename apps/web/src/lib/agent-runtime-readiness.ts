import "server-only";

import { verifyAgentRuntimeReady } from "@neko/llm";

export const AGENT_RUNTIME_UNAVAILABLE_CODE = "agent_runtime_unavailable";

const RECOVERY_MESSAGE =
  "The secure agent runtime is not ready. Restart this OpenNeko stack, wait for `openneko status` to show serving, then try again. If it still fails, run `openneko doctor`.";

export class AgentRuntimeUnavailableError extends Error {
  readonly code = AGENT_RUNTIME_UNAVAILABLE_CODE;

  constructor(options?: { cause?: unknown }) {
    super(RECOVERY_MESSAGE, options);
    this.name = "AgentRuntimeUnavailableError";
  }
}
/**
 * Fail before setup is marked complete or onboarding work is queued unless
 * the exact OpenShell control-plane path used by the profiler is reachable.
 * Keep the underlying CLI error in server logs; browser copy is intentionally
 * stable, actionable, and free of local paths or provider details.
 */
export async function requireAgentRuntimeReady(orgId: string): Promise<void> {
  try {
    await verifyAgentRuntimeReady(orgId);
  } catch (cause) {
    console.warn(
      `[agent-runtime-readiness] OpenShell preflight failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    throw new AgentRuntimeUnavailableError({ cause });
  }
}
