// Starter knowledge packs: OKF bundles shipped with OpenNeko (the
// knowledge-level sibling of Records blueprints). An admin installs a
// pack into the team library; installing IS the approval, so concepts
// land stable with the installer's verification stamp.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { insertLibraryEvent } from "../work/library";
import {
  importLibraryBundleFiles,
  type BundleFile,
  type BundleImportResult,
} from "./bundle";
import { parseConceptDoc, serializeConceptDoc } from "./okf";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS_ROOT = resolve(HERE, "..", "..", "assets", "library-packs");

export type LibraryPack = {
  id: string;
  title: string;
  description: string;
  concepts: number;
};

export async function listLibraryPacks(): Promise<LibraryPack[]> {
  const entries = await readdir(PACKS_ROOT, { withFileTypes: true }).catch(
    () => [],
  );
  const packs: LibraryPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const files = await collectPackFiles(entry.name);
    const index = files.find((f) => f.path === "index.md");
    const meta = index ? parseConceptDoc(index.content) : null;
    packs.push({
      id: entry.name,
      title: meta?.title ?? entry.name,
      description: meta?.description ?? "",
      concepts: files.filter(
        (f) => !f.path.endsWith("index.md") && !f.path.endsWith("log.md"),
      ).length,
    });
  }
  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

export async function installLibraryPack(input: {
  orgId: string;
  packId: string;
  installedBy: string | null;
}): Promise<BundleImportResult> {
  const files = await collectPackFiles(input.packId);
  if (files.length === 0) throw new Error(`Unknown library pack: ${input.packId}`);
  const now = new Date().toISOString();
  const stamped = files.map((file) => stampInstall(file, input.installedBy, now));
  const result = await importLibraryBundleFiles({
    orgId: input.orgId,
    files: stamped,
    importedBy: input.installedBy,
  });
  await insertLibraryEvent({
    orgId: input.orgId,
    userId: input.installedBy,
    action: "pack_installed",
    payload: { packId: input.packId, imported: result.imported },
  });
  return result;
}

// Pack concepts ship without status/verified; installing sets both —
// stable, vouched for by the installing admin.
function stampInstall(
  file: BundleFile,
  installedBy: string | null,
  at: string,
): BundleFile {
  const base = file.path.split("/").at(-1) ?? "";
  if (base === "index.md" || base === "log.md" || !file.path.endsWith(".md")) {
    return file;
  }
  const doc = parseConceptDoc(file.content);
  if (!doc || doc.status || doc.verified) return file;
  return {
    path: file.path,
    content: serializeConceptDoc({
      ...doc,
      status: "stable",
      verified: [{ by: `human:${installedBy ?? "admin"}`, at }],
    }),
  };
}

async function collectPackFiles(packId: string): Promise<BundleFile[]> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(packId)) return [];
  const root = join(PACKS_ROOT, packId);
  const out: BundleFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(absolute, rel);
      else if (entry.name.endsWith(".md")) {
        out.push({ path: rel, content: await readFile(absolute, "utf8") });
      }
    }
  };
  await walk(root, "");
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
