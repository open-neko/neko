import { NextRequest, NextResponse } from "next/server";
import { materializeTeamLibrary } from "@neko/llm";
import { decideLibraryConcept } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin decision on a team draft: approve stamps a human verification
 * and flips it stable; decline archives it. Either way the team OKF
 * bundle is re-materialized so the agent-visible tree tracks the
 * current stable set.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const action = body.action === "decline" ? "decline" : body.action === "approve" ? "approve" : null;
  if (!action) {
    return NextResponse.json(
      { error: 'action must be "approve" or "decline"' },
      { status: 400 },
    );
  }

  try {
    const concept = await decideLibraryConcept({
      orgId,
      id,
      action,
      decidedBy: actor.userId,
    });
    await materializeTeamLibrary(orgId);
    return NextResponse.json({ ok: true, concept });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
