import { NextResponse } from "next/server";
import { extname } from "node:path";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { FORCE_DOWNLOAD_EXTENSIONS, readWorkFile } from "@/lib/work-files";
import {
  getAuthorizedWorkRun,
  getAuthorizedWorkThread,
} from "@/lib/work-thread-auth";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

export const runtime = "nodejs";

export async function GET(_: Request, context: RouteContext) {
  try {
    const { path } = await context.params;
    const relativePath = (path ?? []).join("/");
    const orgId = await getOrgId();
    const actor = await getCurrentActor();
    if (path?.[0] === "uploads") {
      const threadId = path[1] ?? "";
      if (!threadId || !(await getAuthorizedWorkThread(orgId, threadId, actor))) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
    }
    if (path?.[0] === "runs") {
      const runId = path[1] ?? "";
      if (!runId || !(await getAuthorizedWorkRun(orgId, runId, actor))) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
    }
    const file = await readWorkFile(orgId, relativePath);
    const body = new Uint8Array(file.data);
    const disposition = FORCE_DOWNLOAD_EXTENSIONS.has(extname(file.filename).toLowerCase())
      ? "attachment"
      : "inline";
    const safeName = file.filename.replace(/"/g, "");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": file.mimeType,
        "content-disposition": `${disposition}; filename="${safeName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 404 },
    );
  }
}
