import { NextResponse } from "next/server";
import { getOrgId } from "@/lib/db";
import { getRecordSubstrateStatus } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ app }, orgId] = await Promise.all([context.params, getOrgId()]);
    return NextResponse.json({
      status: await getRecordSubstrateStatus({ orgId, appId: app }),
    });
  } catch (error) {
    return recordsApiError(error);
  }
}

