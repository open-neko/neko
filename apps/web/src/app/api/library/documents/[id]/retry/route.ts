import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { enqueue, QUEUE, type LibraryExtractPayload } from "@neko/db/jobs";
import { getLibraryDocument } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Operator retry of a failed or historically skipped document. The extraction
 * checkpoint/artifact is reused when valid, then distillation resumes.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const orgId = await getOrgId();
  const actor = await getCurrentActor();

  const document = await getLibraryDocument(orgId, id);
  if (!document || document.userId !== actor.userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (document.status !== "failed" && document.status !== "skipped") {
    return NextResponse.json(
      { error: `document is ${document.status}; only failed or skipped can be retried` },
      { status: 400 },
    );
  }
  const payload: LibraryExtractPayload = {
    orgId,
    documentId: id,
    runId: randomUUID(),
    sequence: 0,
    force: true,
  };
  await enqueue(QUEUE.LIBRARY_EXTRACT, payload, {
    retryLimit: 8,
    retryDelay: 15,
    retryBackoff: true,
    singletonKey: `library-extract:${id}`,
  });
  return NextResponse.json({ ok: true });
}
