import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve an org-scoped Hermes home without loading host control-plane code. */
export function hermesHomeForOrg(orgId: string): string {
  const override = process.env.HERMES_HOME?.trim();
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0
    ? xdg
    : join(process.env.HOME || homedir(), ".config");
  return join(base, "openneko", "hermes", orgId);
}
