import { NextResponse } from "next/server";
import { getOrgId } from "@/lib/db";
import {
  cancelRecordImportFromWeb,
  getRecordImportStatusForWeb,
  RecordImportWebExecutionError,
  RecordImportWebPermissionError,
} from "@/lib/records-imports";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string; id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ app, id }, orgId] = await Promise.all([context.params, getOrgId()]);
    const run = await getRecordImportStatusForWeb({
      orgId,
      appId: app,
      importRunId: id,
    });
    if (!run) return NextResponse.json({ error: "Import run not found." }, { status: 404 });
    return NextResponse.json({ run });
  } catch (error) {
    if (error instanceof RecordImportWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    return recordsApiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const [{ app, id }, orgId] = await Promise.all([context.params, getOrgId()]);
    const result = await cancelRecordImportFromWeb({
      orgId,
      appId: app,
      importRunId: id,
    });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof RecordImportWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordImportWebExecutionError) {
      return NextResponse.json(
        { error: error.message, actionRequestId: error.actionRequestId },
        { status: 422 },
      );
    }
    return recordsApiError(error);
  }
}

