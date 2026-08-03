import { NextResponse } from "next/server";
import { IdentityMappingError } from "@neko/records";
import { getOrgId } from "@/lib/db";
import {
  decideRecordIdentityForWeb,
  RecordIdentityWebInputError,
  RecordIdentityWebPermissionError,
} from "@/lib/records-identity";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RecordIdentityWebInputError("A JSON decision is required.");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new RecordIdentityWebInputError(`${label} is required.`);
  }
  return value.trim();
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ app }, orgId, parsed] = await Promise.all([
      context.params,
      getOrgId(),
      request.json(),
    ]);
    const body = objectBody(parsed);
    const decision = body.decision;
    if (decision !== "link" && decision !== "ignore") {
      throw new RecordIdentityWebInputError("Choose link or ignore.");
    }
    const mapping = await decideRecordIdentityForWeb({
      orgId,
      appId: app,
      sourceInstanceId: text(body.sourceInstanceId, "Source instance"),
      sourceUserId: text(body.sourceUserId, "Source user"),
      decision,
      ...(decision === "link" ? { appUserId: text(body.appUserId, "OpenNeko user") } : {}),
    });
    return NextResponse.json({ mapping });
  } catch (error) {
    if (error instanceof RecordIdentityWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordIdentityWebInputError || error instanceof IdentityMappingError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "A valid JSON decision is required." }, { status: 400 });
    }
    return recordsApiError(error);
  }
}
