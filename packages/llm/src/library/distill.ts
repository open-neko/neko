// The librarian: distill one library_document into OKF concepts on the
// uploader's personal layer. Flow: triage cheaply → extract text → one
// model pass emitting neko_library fence ops → upsert concepts. The
// model call and text extraction are injectable so tests run without a
// provider or the 22 MB embedding model.

import { join, resolve } from "node:path";
import {
  getLibraryDocument,
  listLibraryConcepts,
  markLibraryDocumentStatus,
  upsertLibraryConcept,
  type LibraryConcept,
} from "../work/library";
import { getOrgAgentRoot } from "../work/workspace";
import { extractDocumentText, type ExtractOutcome } from "./extract";
import { planDocumentChunks } from "./chunk";
import { extractLibraryFences, type LibraryUpsertOp } from "./fence";
import { buildDistillPrompt } from "./prompts";
import { triageUpload } from "./triage";

export type DistillLlm = (prompt: string) => Promise<string>;
export type DistillExtract = (input: {
  absolutePath: string;
  filename: string;
}) => Promise<ExtractOutcome>;

export type LibraryDistillResult = {
  status: "cataloged" | "skipped" | "failed";
  reason?: string;
  concepts: LibraryConcept[];
};

async function defaultLlm(orgId: string): Promise<DistillLlm> {
  const [{ ax }, { buildLlm }] = await Promise.all([
    import("@ax-llm/ax"),
    import("../llm"),
  ]);
  const llm = await buildLlm(orgId);
  const librarian = ax(
    `librarianPrompt:string "librarian instructions plus one uploaded document" -> libraryOperations:string "a single neko_library fenced JSON array of flat objects discriminated by op"`,
    {
      description:
        "You are a meticulous librarian. Follow the instructions in the prompt exactly and respond with only the fenced neko_library block.",
    },
  );
  return async (prompt: string) => {
    const result = await librarian.forward(llm, { librarianPrompt: prompt });
    return String(result.libraryOperations ?? "");
  };
}

export async function runLibraryDistill(input: {
  orgId: string;
  documentId: string;
  /** Bypass triage — used by explicit operator retries. */
  force?: boolean;
  llm?: DistillLlm;
  extract?: DistillExtract;
}): Promise<LibraryDistillResult> {
  const { orgId, documentId } = input;
  const document = await getLibraryDocument(orgId, documentId);
  if (!document) throw new Error(`library document not found: ${documentId}`);
  if (
    !input.force &&
    (document.status === "cataloged" || document.status === "skipped")
  ) {
    return { status: document.status, concepts: [] };
  }
  await markLibraryDocumentStatus({ orgId, id: documentId, status: "distilling" });

  const fail = async (reason: string): Promise<LibraryDistillResult> => {
    await markLibraryDocumentStatus({
      orgId,
      id: documentId,
      status: "failed",
      error: reason,
    });
    return { status: "failed", reason, concepts: [] };
  };
  const skip = async (reason: string): Promise<LibraryDistillResult> => {
    await markLibraryDocumentStatus({
      orgId,
      id: documentId,
      status: "skipped",
      skipReason: reason,
    });
    return { status: "skipped", reason, concepts: [] };
  };

  try {
    // Resolve the raw upload inside the org workspace, guarding traversal
    // the same way readWorkFile does.
    const orgRoot = getOrgAgentRoot(orgId);
    const normalized = document.relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const absolutePath = resolve(join(orgRoot, normalized));
    if (!absolutePath.startsWith(resolve(orgRoot))) {
      return await fail("upload path escapes the org workspace");
    }

    const extract = input.extract ?? extractDocumentText;
    const outcome = await extract({ absolutePath, filename: document.filename });
    if (!outcome.ok) {
      return await fail(outcome.reason);
    }
    const content = outcome.text;

    if (!input.force) {
      const decision = triageUpload({
        filename: document.filename,
        size: document.sizeBytes,
        sample: content.slice(0, 4000),
      });
      if (decision.action === "skip") return await skip(decision.reason);
    }

    const catalog = await listLibraryConcepts({ orgId, userId: document.userId });
    const catalogForPrompt = catalog.map((c) => ({
      path: c.path,
      title: c.title,
      description: c.description ?? undefined,
    }));

    // Map: distill each chunk. Reduce: merge upsert ops by path across chunks
    // so a concept spanning parts is combined, not clobbered. Each chunk is
    // shown the concepts already emitted from this document so the model
    // reuses their paths (update-not-append, extended across parts).
    const chunks = planDocumentChunks(content, outcome.structure.sections);
    const llm = input.llm ?? (await defaultLlm(orgId));
    const merged = new Map<string, LibraryUpsertOp>();
    let skipReason: string | null = null;
    for (const chunk of chunks) {
      const prompt = buildDistillPrompt({
        filename: document.filename,
        content: chunk.text,
        catalog: catalogForPrompt,
        chunk: { index: chunk.index, total: chunk.total, headingPath: chunk.headingPath },
        priorConcepts: [...merged.values()].map((op) => ({ path: op.path, title: op.title })),
      });
      const raw = await llm(prompt);
      const { ops } = extractLibraryFences(raw);
      const upserts = ops.filter((op): op is LibraryUpsertOp => op.kind === "upsert");
      const skipOp = ops.find((op) => op.kind === "skip");
      if (upserts.length === 0 && skipOp) skipReason ??= skipOp.reason;
      for (const op of upserts) {
        const existing = merged.get(op.path);
        merged.set(op.path, existing ? mergeUpsertOps(existing, op) : op);
      }
    }

    if (merged.size === 0) {
      if (skipReason) return await skip(skipReason);
      return await fail("librarian returned no parseable neko_library ops");
    }

    const concepts: LibraryConcept[] = [];
    const now = new Date().toISOString();
    const generatedBy = await producerActor();
    for (const op of merged.values()) {
      const { concept } = await upsertLibraryConcept({
        orgId,
        userId: document.userId,
        path: op.path,
        type: op.type,
        title: op.title,
        description: op.description ?? null,
        tags: op.tags ?? [],
        body: op.body,
        sources: [{ resource: `/${document.relativePath}`, last_modified: now }],
        generatedBy,
        sourceDocumentId: document.id,
        ...(op.stale_after ? { staleAfter: op.stale_after } : {}),
      });
      concepts.push(concept);
    }
    await markLibraryDocumentStatus({ orgId, id: documentId, status: "cataloged" });
    return { status: "cataloged", concepts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await fail(message);
  }
}

/**
 * Reduce step: combine two upsert ops for the same concept path emitted by
 * different chunks. Bodies are concatenated (skipping an exact duplicate),
 * tags unioned, and the more conservative (earlier) expiry kept. The
 * first-seen title/type win — the earliest chunk usually carries the
 * concept's primary framing.
 */
export function mergeUpsertOps(a: LibraryUpsertOp, b: LibraryUpsertOp): LibraryUpsertOp {
  const bodyA = a.body.trim();
  const bodyB = b.body.trim();
  return {
    kind: "upsert",
    path: a.path,
    type: a.type,
    title: a.title,
    description: a.description ?? b.description,
    tags: Array.from(new Set([...(a.tags ?? []), ...(b.tags ?? [])])),
    body: bodyA.includes(bodyB) ? bodyA : `${bodyA}\n\n${bodyB}`,
    stale_after: earlierDate(a.stale_after, b.stale_after),
  };
}

// ISO YYYY-MM-DD strings compare correctly lexicographically.
function earlierDate(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

// OKF actor convention: "<producer>/<version>".
async function producerActor(): Promise<string> {
  try {
    const { readFile: read } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join: pjoin } = await import("node:path");
    const pkgPath = pjoin(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json",
    );
    const pkg = JSON.parse(await read(pkgPath, "utf8")) as { version?: string };
    return `openneko/${pkg.version ?? "dev"}`;
  } catch {
    return "openneko/dev";
  }
}
