import { NextResponse } from "next/server";
import { RecordImportPlanError, RecordsCsvParseError } from "@neko/records";
import { getOrgId } from "@/lib/db";
import {
  previewRecordImport,
  RecordImportWebPermissionError,
  stageRecordImportUpload,
} from "@/lib/records-imports";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    const [form, { app }, orgId] = await Promise.all([
      request.formData(),
      context.params,
      getOrgId(),
    ]);
    const file = form.get("file");
    const objectApiName = form.get("object");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
    }
    if (typeof objectApiName !== "string" || !objectApiName.trim()) {
      return NextResponse.json({ error: "Choose an import object." }, { status: 400 });
    }
    const staged = await stageRecordImportUpload({ orgId, file });
    const plan = await previewRecordImport({
      orgId,
      appId: app,
      objectApiName: objectApiName.trim(),
      sourcePath: staged.sourcePath,
      sourceName: staged.sourceName,
      bytes: staged.bytes,
    });
    return NextResponse.json({ plan });
  } catch (error) {
    if (error instanceof RecordImportWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordImportPlanError || error instanceof RecordsCsvParseError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Error && /CSV|Import source|\.csv/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return recordsApiError(error);
  }
}

