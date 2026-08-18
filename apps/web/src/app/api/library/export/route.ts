import { NextResponse } from "next/server";
import { collectLibraryBundleFiles } from "@neko/llm";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Export the team library as a portable OKF bundle: JSON of
 * {path, content} markdown files, downloadable and re-importable here
 * or readable by any OKF consumer once unpacked to a directory.
 */
export async function GET() {
  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const files = await collectLibraryBundleFiles(orgId);
  return NextResponse.json(
    { ok: true, okf_version: "0.2", files },
    {
      headers: {
        "content-disposition": 'attachment; filename="library-okf-bundle.json"',
      },
    },
  );
}
