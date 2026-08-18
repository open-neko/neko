import { NextResponse } from "next/server";
import {
  listLibraryConcepts,
  listLibraryDocuments,
} from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Library overview for the current actor: their uploaded documents,
 * their personal concepts, the approved team layer, and — for admins —
 * the team drafts awaiting a decision.
 */
export async function GET() {
  const orgId = await getOrgId();
  const actor = await getCurrentActor();

  const [documents, personal, team, pending] = await Promise.all([
    listLibraryDocuments({ orgId, userId: actor.userId }),
    listLibraryConcepts({ orgId, userId: actor.userId }),
    listLibraryConcepts({ orgId, userId: null, status: "stable" }),
    actor.role === "admin"
      ? listLibraryConcepts({ orgId, userId: null, status: "draft" })
      : Promise.resolve([]),
  ]);

  return NextResponse.json({
    ok: true,
    documents,
    personal,
    team,
    pending,
  });
}
