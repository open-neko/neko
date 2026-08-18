// Writes and maintains an OKF bundle tree on disk: concept docs plus the
// reserved index.md (per-directory catalog, okf_version at the bundle
// root) and log.md (chronological history). The tree is a projection —
// Postgres stays the system of record for concept rows; this mirrors
// them for the agent's wiki-walk retrieval path, humans, and config-VCS.

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  OKF_VERSION,
  type OkfConceptDoc,
  parseConceptDoc,
  serializeConceptDoc,
} from "./okf";
import { isValidConceptPath } from "./fence";

export type ConceptWrite = {
  /** Bundle-relative path, validated by isValidConceptPath. */
  path: string;
  doc: OkfConceptDoc;
};

export async function writeConceptDoc(
  bundleRoot: string,
  write: ConceptWrite,
): Promise<void> {
  if (!isValidConceptPath(write.path)) {
    throw new Error(`invalid concept path: ${write.path}`);
  }
  const absolute = join(bundleRoot, ...write.path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, serializeConceptDoc(write.doc), "utf8");
}

export async function appendLog(
  bundleRoot: string,
  message: string,
  at: Date,
): Promise<void> {
  await mkdir(bundleRoot, { recursive: true });
  const line = `- ${at.toISOString()} — ${message.replace(/\r?\n/g, " ").trim()}\n`;
  const logPath = join(bundleRoot, "log.md");
  const exists = await readFile(logPath, "utf8").catch(() => null);
  if (exists === null) {
    await writeFile(logPath, `# Log\n\n${line}`, "utf8");
  } else {
    await appendFile(logPath, line, "utf8");
  }
}

type IndexEntry = {
  name: string;
  title: string;
  description?: string;
  isDir: boolean;
};

/**
 * Regenerate index.md for every directory in the bundle, bottom-up.
 * Root index declares okf_version. Safe to call after any batch of
 * concept writes; skips silently if the root doesn't exist yet.
 */
export async function rebuildIndexes(bundleRoot: string): Promise<void> {
  const dirs = await collectDirs(bundleRoot);
  if (dirs === null) return;
  for (const dir of dirs) {
    const entries = await collectEntries(dir);
    const isRoot = dir === bundleRoot;
    const relDir = relative(bundleRoot, dir).split(sep).filter(Boolean);
    const heading = isRoot ? "Library" : relDir[relDir.length - 1];
    const lines: string[] = [];
    lines.push("---");
    if (isRoot) lines.push(`okf_version: "${OKF_VERSION}"`);
    lines.push(`title: ${JSON.stringify(heading)}`);
    lines.push("---");
    lines.push("");
    lines.push(`# ${heading}`);
    lines.push("");
    for (const entry of entries) {
      const label = entry.isDir ? `${entry.title}/` : entry.title;
      const target = entry.isDir ? `${entry.name}/index.md` : entry.name;
      const suffix = entry.description ? ` — ${entry.description}` : "";
      lines.push(`- [${label}](${target})${suffix}`);
    }
    lines.push("");
    await writeFile(join(dir, "index.md"), lines.join("\n"), "utf8");
  }
}

async function collectDirs(root: string): Promise<string[] | null> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    found.push(dir);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await walk(join(dir, entry.name));
    }
  };
  try {
    await walk(root);
  } catch {
    return null;
  }
  // Deepest first so parents could aggregate children later if needed.
  return found.sort((a, b) => b.length - a.length);
}

async function collectEntries(dir: string): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push({ name: entry.name, title: entry.name, isDir: true });
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name === "index.md" || entry.name === "log.md") continue;
    const raw = await readFile(join(dir, entry.name), "utf8").catch(() => null);
    const doc = raw === null ? null : parseConceptDoc(raw);
    out.push({
      name: entry.name,
      title: doc?.title ?? entry.name.replace(/\.md$/, ""),
      description: doc?.description,
      isDir: false,
    });
  }
  return out.sort((a, b) =>
    a.isDir === b.isDir ? a.title.localeCompare(b.title) : a.isDir ? -1 : 1,
  );
}
