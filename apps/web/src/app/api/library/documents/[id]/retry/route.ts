import { NextRequest, NextResponse } from "next/server";
import { enqueue, QUEUE, type LibraryDistillPayload } from "@neko/db/jobs";
import { getLibraryDocument } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Operator retry of a failed or skipped distill. Force-runs the
 * librarian (bypassing triage) — an explicit "catalog this anyway".
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
  const payload: LibraryDistillPayload = { orgId, documentId: id, force: true };
  await enqueue(QUEUE.LIBRARY_DISTILL, payload, {
    singletonKey: `library-distill:${id}`,
  });
  return NextResponse.json({ ok: true });
}
