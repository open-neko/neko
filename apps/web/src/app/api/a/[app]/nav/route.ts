import { NextResponse } from "next/server";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { getRecordAppNav } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ app }, orgId, actor] = await Promise.all([
      context.params,
      getOrgId(),
      getCurrentActor(),
    ]);
    const result = await getRecordAppNav({
      orgId,
      appId: app,
      role: actor.role === "member" ? "member" : "admin",
    });
    return NextResponse.json({ app: result });
  } catch (error) {
    return recordsApiError(error);
  }
}

