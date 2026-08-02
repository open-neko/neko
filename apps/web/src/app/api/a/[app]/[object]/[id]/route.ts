import { NextResponse } from "next/server";
import { getOrgId } from "@/lib/db";
import { readRecordDetail } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ app: string; object: string; id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ app, object, id }, orgId] = await Promise.all([
      context.params,
      getOrgId(),
    ]);
    const result = await readRecordDetail({
      orgId,
      appId: app,
      objectApiName: object,
      recordId: id,
    });
    if (!result.row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (error) {
    return recordsApiError(error);
  }
}

