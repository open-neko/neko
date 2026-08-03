import { NextResponse } from "next/server";
import { getOrgId } from "@/lib/db";
import {
  RecordIdentityWebExecutionError,
  RecordIdentityWebInputError,
  RecordIdentityWebPermissionError,
  runRecordIdentityBackfillFromWeb,
} from "@/lib/records-identity";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ app }, orgId, body] = await Promise.all([
      context.params,
      getOrgId(),
      request.json() as Promise<Record<string, unknown>>,
    ]);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new RecordIdentityWebInputError("A JSON backfill request is required.");
    }
    if (typeof body.sourceInstanceId !== "string") {
      throw new RecordIdentityWebInputError("Choose a source instance.");
    }
    if (body.sourceUserId !== undefined && typeof body.sourceUserId !== "string") {
      throw new RecordIdentityWebInputError("Source user must be a string.");
    }
    const result = await runRecordIdentityBackfillFromWeb({
      orgId,
      appId: app,
      sourceInstanceId: body.sourceInstanceId,
      ...(body.sourceUserId ? { sourceUserId: body.sourceUserId } : {}),
    });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof RecordIdentityWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordIdentityWebInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: "A valid JSON backfill request is required." },
        { status: 400 },
      );
    }
    if (error instanceof RecordIdentityWebExecutionError) {
      return NextResponse.json(
        { error: error.message, actionRequestId: error.actionRequestId },
        { status: 422 },
      );
    }
    return recordsApiError(error);
  }
}
