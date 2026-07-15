import { NextResponse } from "next/server";
import { abortRun } from "@/lib/neko-run-registry";
import { getOrgId } from "@/lib/db";
import { getAuthorizedWorkRun } from "@/lib/work-thread-auth";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

export async function POST(_: Request, context: RouteContext) {
  const { runId } = await context.params;
  const run = await getAuthorizedWorkRun(await getOrgId(), runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const ok = abortRun(runId);
  return NextResponse.json({ ok });
}
