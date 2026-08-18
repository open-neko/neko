// Parses distiller-emitted `neko_library` fences into concept operations,
// mirroring the neko_memory fence pattern in agent-backends/memory-fence.ts.
//
// Fence shape:
//   ```neko_library
//   [
//     { "upsert": { "path": "policies/refund-policy.md", "type": "Policy",
//                   "title": "Refund policy", "description": "...",
//                   "tags": ["finance"], "body": "..." } },
//     { "skip": { "reason": "one-off working data, not durable knowledge" } }
//   ]
//   ```
//
// Multiple upserts are allowed (one document can yield several concepts).
// A `skip` op marks the source document as triaged-out. Anything not
// matching the spec is silently dropped.

const NEKO_LIBRARY_FENCE_RE = /```neko_library\s*([\s\S]*?)```/gi;

export type LibraryUpsertOp = {
  kind: "upsert";
  /** Bundle-relative concept path, e.g. "policies/refund-policy.md". */
  path: string;
  type: string;
  title: string;
  description?: string;
  tags?: string[];
  body: string;
  /** YYYY-MM-DD after which this concept should be treated as stale. */
  stale_after?: string;
};

export type LibrarySkipOp = {
  kind: "skip";
  reason: string;
};

export type LibraryOp = LibraryUpsertOp | LibrarySkipOp;

export type LibraryFenceExtraction = {
  text: string;
  ops: LibraryOp[];
};

const CONCEPT_PATH_RE = /^[a-z0-9][a-z0-9/_-]*\.md$/;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

/** Reject traversal, absolute paths, and the reserved index/log names. */
export function isValidConceptPath(path: string): boolean {
  if (!CONCEPT_PATH_RE.test(path)) return false;
  const segments = path.split("/");
  if (segments.some((s) => s.length === 0 || s === "." || s === "..")) {
    return false;
  }
  const base = segments[segments.length - 1];
  return base !== "index.md" && base !== "log.md";
}

function parseUpsert(value: unknown): LibraryUpsertOp | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (!isStr(o.path) || !isValidConceptPath(o.path)) return null;
  if (!isStr(o.type) || o.type.trim().length === 0) return null;
  if (!isStr(o.title) || o.title.trim().length === 0) return null;
  if (!isStr(o.body) || o.body.trim().length < 3) return null;
  return {
    kind: "upsert",
    path: o.path,
    type: o.type.trim(),
    title: o.title.trim(),
    description: isStr(o.description) ? o.description.trim() : undefined,
    tags: Array.isArray(o.tags)
      ? o.tags.filter(isStr).map((t) => t.trim()).filter(Boolean)
      : undefined,
    body: o.body.trim(),
    stale_after:
      isStr(o.stale_after) && /^\d{4}-\d{2}-\d{2}$/.test(o.stale_after)
        ? o.stale_after
        : undefined,
  };
}

function parseItem(item: unknown): LibraryOp | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  if ("upsert" in o) return parseUpsert(o.upsert);
  if ("skip" in o) {
    const skip = o.skip;
    if (skip && typeof skip === "object" && isStr((skip as Record<string, unknown>).reason)) {
      return { kind: "skip", reason: String((skip as Record<string, unknown>).reason) };
    }
    return null;
  }
  return null;
}

export function extractLibraryFences(raw: string): LibraryFenceExtraction {
  const ops: LibraryOp[] = [];
  let stripped = raw;
  const matches = Array.from(raw.matchAll(NEKO_LIBRARY_FENCE_RE));
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const op = parseItem(item);
        if (op) ops.push(op);
      }
    } catch {
      // Malformed JSON — strip the fence, keep no ops.
    }
    stripped = stripped.replace(m[0], "");
  }
  return { text: stripped.trim(), ops };
}
