import { NextRequest, NextResponse } from "next/server";
import { importLibraryBundleFiles } from "@neko/llm";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 500;
const MAX_CONTENT = 512 * 1024;

/**
 * Import an OKF bundle (the JSON shape /api/library/export produces)
 * into the team layer. Trust state travels with the bundle — importing
 * is an admin act, so verified stamps and statuses are restored as-is;
 * concepts without a status land as drafts awaiting approval.
 */
export async function POST(request: NextRequest) {
  const orgId = await getOrgId();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  const rawFiles = body && Array.isArray(body.files) ? body.files : null;
  if (!rawFiles) {
    return NextResponse.json(
      { error: "body must be { files: [{ path, content }] }" },
      { status: 400 },
    );
  }
  if (rawFiles.length > MAX_FILES) {
    return NextResponse.json(
      { error: `bundle has more than ${MAX_FILES} files` },
      { status: 413 },
    );
  }
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of rawFiles) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      typeof entry.content !== "string" ||
      entry.content.length > MAX_CONTENT
    ) {
      return NextResponse.json(
        { error: "each file needs a string path and content (max 512 KB)" },
        { status: 400 },
      );
    }
    files.push({ path: entry.path, content: entry.content });
  }
  const result = await importLibraryBundleFiles({
    orgId,
    files,
    importedBy: actor.userId,
  });
  return NextResponse.json({ ok: true, ...result });
}
