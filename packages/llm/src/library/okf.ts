// Open Knowledge Format (OKF v0.2) concept documents: markdown files with
// YAML frontmatter, per https://github.com/GoogleCloudPlatform/knowledge-catalog.
// The library distiller writes these; the agent and humans read them. Only
// `type` is required by the spec — everything else here is the optional
// v0.2 vocabulary (sources/generated/verified/status/stale_after) plus
// OpenNeko extension keys, which OKF consumers must tolerate.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const OKF_VERSION = "0.2";

export type OkfSource = {
  resource: string;
  last_modified?: string;
};

export type OkfActorStamp = {
  by: string;
  at: string;
};

export type OkfStatus = "draft" | "stable" | "deprecated";

export type OkfConceptDoc = {
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  sources?: OkfSource[];
  generated?: OkfActorStamp;
  verified?: OkfActorStamp[];
  status?: OkfStatus;
  stale_after?: string;
  /** Unknown/extension frontmatter keys, preserved round-trip. */
  extra?: Record<string, unknown>;
  body: string;
};

// Stable field order keeps git diffs of regenerated docs minimal.
const FIELD_ORDER = [
  "type",
  "title",
  "description",
  "tags",
  "resource",
  "sources",
  "generated",
  "verified",
  "status",
  "stale_after",
] as const;

const KNOWN_FIELDS = new Set<string>(FIELD_ORDER);

export function serializeConceptDoc(doc: OkfConceptDoc): string {
  const front: Record<string, unknown> = {};
  const candidate: Record<string, unknown> = {
    type: doc.type,
    title: doc.title,
    description: doc.description,
    tags: doc.tags && doc.tags.length > 0 ? doc.tags : undefined,
    sources: doc.sources && doc.sources.length > 0 ? doc.sources : undefined,
    generated: doc.generated,
    verified: doc.verified && doc.verified.length > 0 ? doc.verified : undefined,
    status: doc.status,
    stale_after: doc.stale_after,
  };
  for (const key of FIELD_ORDER) {
    if (candidate[key] !== undefined) front[key] = candidate[key];
  }
  for (const [key, value] of Object.entries(doc.extra ?? {})) {
    if (!KNOWN_FIELDS.has(key) && value !== undefined) front[key] = value;
  }
  const yaml = stringifyYaml(front, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${doc.body.trim()}\n`;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Tolerant parse per OKF conformance rules: a doc without parseable
 * frontmatter or a non-empty `type` is not a concept doc — return null
 * rather than throw, so directory walks skip stray files gracefully.
 */
export function parseConceptDoc(raw: string): OkfConceptDoc | null {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return null;
  let front: unknown;
  try {
    front = parseYaml(match[1]);
  } catch {
    return null;
  }
  if (!front || typeof front !== "object" || Array.isArray(front)) return null;
  const f = front as Record<string, unknown>;
  if (typeof f.type !== "string" || f.type.trim().length === 0) return null;

  const doc: OkfConceptDoc = {
    type: f.type.trim(),
    body: raw.slice(match[0].length).trim(),
  };
  if (typeof f.title === "string") doc.title = f.title;
  if (typeof f.description === "string") doc.description = f.description;
  if (Array.isArray(f.tags)) {
    doc.tags = f.tags.filter((t): t is string => typeof t === "string");
  }
  if (Array.isArray(f.sources)) {
    doc.sources = f.sources.flatMap((s): OkfSource[] => {
      if (typeof s === "string") return [{ resource: s }];
      if (s && typeof s === "object" && typeof (s as OkfSource).resource === "string") {
        const src = s as Record<string, unknown>;
        return [
          {
            resource: String(src.resource),
            ...(typeof src.last_modified === "string"
              ? { last_modified: src.last_modified }
              : {}),
          },
        ];
      }
      return [];
    });
  }
  const generated = parseActorStamp(f.generated);
  if (generated) doc.generated = generated;
  if (f.verified !== undefined) {
    const list = Array.isArray(f.verified) ? f.verified : [f.verified];
    const stamps = list
      .map(parseActorStamp)
      .filter((s): s is OkfActorStamp => s !== null);
    if (stamps.length > 0) doc.verified = stamps;
  }
  if (f.status === "draft" || f.status === "stable" || f.status === "deprecated") {
    doc.status = f.status;
  }
  if (typeof f.stale_after === "string") doc.stale_after = f.stale_after;

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(f)) {
    if (!KNOWN_FIELDS.has(key)) extra[key] = value;
  }
  if (Object.keys(extra).length > 0) doc.extra = extra;
  return doc;
}

function parseActorStamp(value: unknown): OkfActorStamp | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.by !== "string" || typeof v.at !== "string") return null;
  return { by: v.by, at: v.at };
}

/** Filesystem-safe slug for concept filenames, mirroring workflowSlug. */
export function conceptSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "concept"
  );
}
