import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { enqueue, QUEUE, type LibraryDistillPayload } from "@neko/db/jobs";
import { createLibraryDocument } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_UPLOAD_SIZE,
  saveLibraryUpload,
} from "@/lib/work-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Direct-to-library upload (no thread). Always catalogs — uploading
 * here IS the request to distill. Files land under
 * library/uploads/<owner>/ and stay owner-readable only.
 */
export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength && contentLength > MAX_UPLOAD_SIZE + 4096) {
    return NextResponse.json(
      { error: `File is over ${Math.round(MAX_UPLOAD_SIZE / (1024 * 1024))} MB.` },
      { status: 413 },
    );
  }
  const form = await request.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "Invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return NextResponse.json(
      { error: `"${file.name}" is over ${Math.round(MAX_UPLOAD_SIZE / (1024 * 1024))} MB.` },
      { status: 413 },
    );
  }
  const idx = file.name.lastIndexOf(".");
  const ext = idx > 0 ? file.name.slice(idx).toLowerCase() : "";
  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: `Unsupported file type "${ext || "(none)"}".` },
      { status: 415 },
    );
  }

  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  const saved = await saveLibraryUpload(orgId, actor.userId, file);
  const contentHash = createHash("sha256")
    .update(Buffer.from(await file.arrayBuffer()))
    .digest("hex");
  const { document, created } = await createLibraryDocument({
    orgId,
    userId: actor.userId,
    filename: saved.name,
    relativePath: saved.relativePath.replace(/\\/g, "/"),
    contentHash,
    sizeBytes: saved.size,
  });
  if (created || document.status === "failed") {
    const payload: LibraryDistillPayload = { orgId, documentId: document.id };
    await enqueue(QUEUE.LIBRARY_DISTILL, payload, {
      singletonKey: `library-distill:${document.id}`,
    });
  }
  return NextResponse.json({ ok: true, document, created });
}
