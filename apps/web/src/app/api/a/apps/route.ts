import { NextResponse } from "next/server";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { listRecordAppsForViewer } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [orgId, actor] = await Promise.all([getOrgId(), getCurrentActor()]);
    const apps = await listRecordAppsForViewer({
      orgId,
      role: actor.role === "member" ? "member" : "admin",
    });
    return NextResponse.json({ apps });
  } catch (error) {
    return recordsApiError(error);
  }
}

