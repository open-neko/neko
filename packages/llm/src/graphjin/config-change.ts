import { createHash } from "node:crypto";

export type ResolveSourceSecret = (name: string) => Promise<string>;

function canonicalConfigValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalConfigValue).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalConfigValue(item)}`,
    )
    .join(",")}}`;
}

/** Stable across JSONB key reordering between preview and approved execution. */
export function graphjinConfigPatchHash(payload: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalConfigValue(payload))
    .digest("hex");
}

/** Serialize a JS value to GraphJin's inline gj_config input syntax. */
export function graphjinInputValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(graphjinInputValue).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `${key}: ${graphjinInputValue(item)}`);
  return `{ ${entries.join(", ")} }`;
}

/**
 * Convert OpenNeko's narrow, typed source-config proposal into GraphJin's
 * additive patch shape. The optional resolver is trusted host code; a secret
 * value is never accepted from, or returned to, the model.
 */
export async function buildGraphjinConfigUpdate(
  payload: Record<string, unknown>,
  resolveSecret?: ResolveSourceSecret,
): Promise<{ update: Record<string, unknown>; secretName: string | null }> {
  const action = String(payload.action ?? "");
  const update: Record<string, unknown> = {};
  let secretName: string | null = null;

  if (action === "add_role") {
    const name = String(payload.name ?? "").trim();
    const match = String(payload.match ?? "").trim();
    if (!name || !match) throw new Error("add_role needs name + match");
    const role: Record<string, unknown> = { name, match };
    if (typeof payload.comment === "string" && payload.comment.trim()) {
      role.comment = payload.comment.trim();
    }
    update.roles = [role];
    return { update, secretName };
  }

  if (action === "set_source_access") {
    const source = String(payload.source ?? "").trim();
    if (!source) throw new Error("set_source_access needs source");
    const access: Record<string, unknown> = {};
    if (payload.read) access.read = String(payload.read);
    if (payload.write) access.write = String(payload.write);
    if (payload.delete) access.delete = String(payload.delete);
    if (Object.keys(access).length === 0) {
      throw new Error("set_source_access needs at least one access field");
    }
    update.source_patches = [{ name: source, access }];
    return { update, secretName };
  }

  if (action === "register_source") {
    const name = String(payload.name ?? "").trim();
    const kind = String(payload.kind ?? "database");
    if (!name) throw new Error("register_source needs name");
    const source: Record<string, unknown> = { name, kind };
    if (kind === "database") {
      source.type = String(payload.type ?? "postgres");
      if (payload.host) source.host = String(payload.host);
      if (payload.port) source.port = Number(payload.port);
      if (payload.dbname) source.dbname = String(payload.dbname);
      if (payload.user) source.user = String(payload.user);
      source.access = {
        read: String(payload.read ?? "authenticated"),
        write: String(payload.write ?? "blocked"),
        delete: String(payload.delete ?? "blocked"),
      };
      const ref =
        typeof payload.secretRef === "string" ? payload.secretRef.trim() : "";
      if (ref) {
        if (!resolveSecret) {
          throw new Error("register_source secret resolution is unavailable");
        }
        secretName = ref;
        source.password = await resolveSecret(ref);
      }
    }
    update.update_sources = [source];
    return { update, secretName };
  }

  throw new Error(`unknown source config action "${action}"`);
}
