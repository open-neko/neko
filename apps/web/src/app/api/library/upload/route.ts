import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { enqueue, QUEUE, type LibraryExtractPayload } from "@neko/db/jobs";
import { createLibraryDocument } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import {
  MAX_LIBRARY_UPLOAD_REQUEST_BYTES,
  validateLibraryUploadBatch,
} from "@/lib/library-upload-contract";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  safeFileName,
  saveLibraryUpload,
} from "@/lib/work-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Direct-to-library upload (no thread). Always catalogs — uploading
 * here IS the request to distill. A batch may contain up to 100 MB of files
 * in total. Files land under content-addressed paths beneath
 * library/uploads/<owner>/ and stay owner-readable only.
 */
export async function POST(request: Request) {
  const contentLength = Number.parseInt(
    request.headers.get("content-length") ?? "0",
    10,
  );
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_LIBRARY_UPLOAD_REQUEST_BYTES
  ) {
    return NextResponse.json(
      {
        error:
          "The selected files exceed the 100 MB import limit. Choose fewer or smaller files.",
      },
      { status: 413 },
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  // `files` is the batch contract. Keep accepting the original singular
  // field so existing API clients continue to work after the UI switches.
  const files = [...form.getAll("files"), ...form.getAll("file")].filter(
    (value): value is File => value instanceof File,
  );
  const validation = validateLibraryUploadBatch(files);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.error },
      { status: validation.status },
    );
  }

  const names = new Set<string>();
  for (const file of files) {
    const safeName = safeFileName(file.name);
    if (names.has(safeName)) {
      return NextResponse.json(
        {
          error: `More than one selected file becomes "${safeName}" after filename cleanup. Rename one and try again.`,
        },
        { status: 400 },
      );
    }
    names.add(safeName);
    const idx = file.name.lastIndexOf(".");
    const ext = idx > 0 ? file.name.slice(idx).toLowerCase() : "";
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
      return NextResponse.json(
        { error: `Unsupported file type "${ext || "(none)"}".` },
        { status: 415 },
      );
    }
  }

  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  const documents: Array<{
    document: Awaited<ReturnType<typeof createLibraryDocument>>["document"];
    created: boolean;
  }> = [];
  for (const file of files) {
    const saved = await saveLibraryUpload(orgId, actor.userId, file);
    const { document, created } = await createLibraryDocument({
      orgId,
      userId: actor.userId,
      filename: saved.name,
      relativePath: saved.relativePath.replace(/\\/g, "/"),
      contentHash: saved.contentHash,
      sizeBytes: saved.size,
    });
    // `uploaded` also covers recovery from the narrow insert-before-enqueue
    // failure window: an identical re-upload must be able to restore the job.
    if (created || document.status === "uploaded" || document.status === "failed") {
      const payload: LibraryExtractPayload = {
        orgId,
        documentId: document.id,
        runId: randomUUID(),
        sequence: 0,
      };
      await enqueue(QUEUE.LIBRARY_EXTRACT, payload, {
        retryLimit: 8,
        retryDelay: 15,
        retryBackoff: true,
        singletonKey: `library-extract:${document.id}`,
      });
    }
    documents.push({ document, created });
  }

  // Keep the singular response members for clients that still post `file`.
  return NextResponse.json({
    ok: true,
    documents,
    document: documents[0]?.document,
    created: documents[0]?.created,
  });
}
