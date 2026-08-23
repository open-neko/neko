import type { AgentBackend, AgentBackendId } from "./agent-backend";
import { HermesBackend } from "./agent-backends/hermes";

/** Pure runtime factory used inside the OpenShell agent image. */
export function makeAgentBackend(cfg: { id: AgentBackendId }): AgentBackend {
  if (cfg.id !== "hermes") {
    throw new Error(`Unsupported agent backend: ${String(cfg.id)}`);
  }
  return new HermesBackend();
}
