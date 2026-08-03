import { NextResponse } from "next/server";
import { getOrgId } from "@/lib/db";
import { readRecordReferenceOptions } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string; object: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const [{ app, object }, orgId] = await Promise.all([context.params, getOrgId()]);
    const query = new URL(request.url).searchParams.get("q") ?? "";
    const options = await readRecordReferenceOptions({
      orgId,
      appId: app,
      objectApiName: object,
      search: query,
    });
    return NextResponse.json({ options });
  } catch (error) {
    return recordsApiError(error);
  }
}
