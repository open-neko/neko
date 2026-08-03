import { NextResponse } from "next/server";
import { RecordImportPlanError, RecordsCsvParseError } from "@neko/records";
import { getOrgId } from "@/lib/db";
import {
  previewRecordImport,
  RecordImportWebExecutionError,
  RecordImportWebPermissionError,
  startRecordImportFromWeb,
} from "@/lib/records-imports";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function mapping(value: unknown): Record<string, string | null> {
  if (!isRecord(value)) throw new Error("mapping must be an object.");
  return Object.fromEntries(
    Object.entries(value).map(([source, target]) => {
      if (target !== null && typeof target !== "string") {
        throw new Error("mapping targets must be field names or null.");
      }
      return [source, target === null ? null : target.trim()];
    }),
  );
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [body, { app }, orgId] = await Promise.all([
      request.json() as Promise<unknown>,
      context.params,
      getOrgId(),
    ]);
    if (!isRecord(body)) throw new Error("Request body must be an object.");
    const plan = await previewRecordImport({
      orgId,
      appId: app,
      objectApiName: requiredString(body, "object"),
      sourcePath: requiredString(body, "sourcePath"),
      sourceName: requiredString(body, "sourceName"),
      mapping: mapping(body.mapping),
      duplicateKey:
        typeof body.duplicateKey === "string" ? body.duplicateKey.trim() : undefined,
      batchSize: Number.isSafeInteger(body.batchSize) ? Number(body.batchSize) : undefined,
      emptyTextColumns: Array.isArray(body.emptyTextColumns)
        ? body.emptyTextColumns.filter((value): value is string => typeof value === "string")
        : undefined,
    });
    const result = await startRecordImportFromWeb({ orgId, plan });
    return NextResponse.json(result, { status: result.status === "queued" ? 202 : 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body is malformed JSON." }, { status: 400 });
    }
    if (error instanceof RecordImportWebPermissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecordImportWebExecutionError) {
      return NextResponse.json(
        { error: error.message, actionRequestId: error.actionRequestId },
        { status: 422 },
      );
    }
    if (
      error instanceof RecordImportPlanError ||
      error instanceof RecordsCsvParseError ||
      (error instanceof Error && /required|mapping/i.test(error.message))
    ) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return recordsApiError(error);
  }
}

