import { NextRequest, NextResponse } from "next/server";
import { archiveLibraryConcept } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/** Owner archives one of their personal concepts. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  try {
    const concept = await archiveLibraryConcept({
      orgId,
      id,
      userId: actor.userId,
    });
    return NextResponse.json({ ok: true, concept });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
