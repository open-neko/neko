import { NextResponse } from "next/server";
import { RecordValidationError } from "@neko/records";
import { getOrgId } from "@/lib/db";
import {
  RecordFormExecutionError,
  RecordFormPolicyError,
  submitRecordFormAction,
  type RecordFormOperation,
} from "@/lib/records-actions";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string; object: string }> };

function operation(value: unknown): RecordFormOperation | null {
  return value === "create" || value === "update" ? value : null;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [body, { app, object }, orgId] = await Promise.all([
      request.json() as Promise<Record<string, unknown>>,
      context.params,
      getOrgId(),
    ]);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
    }
    const formOperation = operation(body.operation);
    if (!formOperation) {
      return NextResponse.json(
        { error: "operation must be create or update" },
        { status: 400 },
      );
    }
    const result = await submitRecordFormAction({
      orgId,
      appId: app,
      objectApiName: object,
      operation: formOperation,
      recordId: typeof body.id === "string" ? body.id : undefined,
      fields: body.fields,
      expected: body.expected,
    });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "request body is malformed JSON" }, { status: 400 });
    }
    if (error instanceof RecordValidationError) {
      return NextResponse.json(
        { error: "Record validation failed.", issues: error.issues },
        { status: 400 },
      );
    }
    if (error instanceof RecordFormPolicyError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordFormExecutionError) {
      return NextResponse.json(
        { error: error.message, actionRequestId: error.actionRequestId },
        { status: 422 },
      );
    }
    return recordsApiError(error);
  }
}
