import { NextResponse } from "next/server";
import { listLibraryPacks } from "@neko/llm";
import { getCurrentActor } from "@/lib/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const actor = await getCurrentActor();
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, packs: await listLibraryPacks() });
}
