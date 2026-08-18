import { NextRequest, NextResponse } from "next/server";
import { getLibraryConcept, shareLibraryConceptToTeam } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Share one of your personal concepts into the team layer as a draft
 * awaiting admin approval. Ownership gate, not a role gate: only the
 * concept's owner can share it, and non-owners get 404 (existence is
 * not leaked).
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const orgId = await getOrgId();
  const actor = await getCurrentActor();

  const concept = await getLibraryConcept(orgId, id);
  if (!concept || concept.archivedAt || concept.userId !== actor.userId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  try {
    const shared = await shareLibraryConceptToTeam({
      orgId,
      id,
      sharedBy: actor.userId,
    });
    return NextResponse.json({ ok: true, concept: shared });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
