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
import { extractLibraryFences, type LibraryUpsertOp } from "./fence";
import { buildDistillPrompt, DISTILL_CONTENT_LIMIT } from "./prompts";
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
    `prompt:string "librarian instructions plus one uploaded document" -> response:string "a single neko_library fenced code block containing a JSON array of ops"`,
    {
      description:
        "You are a meticulous librarian. Follow the instructions in the prompt exactly and respond with only the fenced neko_library block.",
    },
  );
  return async (prompt: string) => {
    const result = await librarian.forward(llm, { prompt });
    return String(result.response ?? "");
  };
}

export async function runLibraryDistill(input: {
  orgId: string;
  documentId: string;
  llm?: DistillLlm;
  extract?: DistillExtract;
}): Promise<LibraryDistillResult> {
  const { orgId, documentId } = input;
  const document = await getLibraryDocument(orgId, documentId);
  if (!document) throw new Error(`library document not found: ${documentId}`);
  if (document.status === "cataloged" || document.status === "skipped") {
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

    const decision = triageUpload({
      filename: document.filename,
      size: document.sizeBytes,
      sample: content.slice(0, 4000),
    });
    if (decision.action === "skip") return await skip(decision.reason);

    const catalog = await listLibraryConcepts({ orgId, userId: document.userId });
    const truncated = content.length > DISTILL_CONTENT_LIMIT;
    const prompt = buildDistillPrompt({
      filename: document.filename,
      content: truncated ? content.slice(0, DISTILL_CONTENT_LIMIT) : content,
      catalog: catalog.map((c) => ({
        path: c.path,
        title: c.title,
        description: c.description ?? undefined,
      })),
      truncated,
    });

    const llm = input.llm ?? (await defaultLlm(orgId));
    const raw = await llm(prompt);
    const { ops } = extractLibraryFences(raw);
    if (ops.length === 0) {
      return await fail("librarian returned no parseable neko_library ops");
    }
    const skipOp = ops.find((op) => op.kind === "skip");
    const upserts = ops.filter((op): op is LibraryUpsertOp => op.kind === "upsert");
    if (upserts.length === 0 && skipOp) return await skip(skipOp.reason);

    const concepts: LibraryConcept[] = [];
    const now = new Date().toISOString();
    for (const op of upserts) {
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
        generatedBy: await producerActor(),
        sourceDocumentId: document.id,
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
