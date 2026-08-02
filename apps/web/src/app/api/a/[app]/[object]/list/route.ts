import { NextResponse } from "next/server";
import {
  normalizeRecordSavedViewDefinition,
  type RecordFilterExpression,
  type RecordListFilter,
} from "@neko/records";
import { getOrgId } from "@/lib/db";
import { readRecordList } from "@/lib/records";
import { recordsApiError } from "@/lib/records-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string; object: string }> };

function filtersFrom(url: URL): RecordListFilter[] | undefined {
  const raw = url.searchParams.get("filters");
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length > 20) {
    throw new Error("record filters must be an array of at most 20 entries");
  }
  return parsed as RecordListFilter[];
}

function filterFrom(url: URL): RecordFilterExpression | undefined {
  const raw = url.searchParams.get("filter");
  if (!raw) return undefined;
  return normalizeRecordSavedViewDefinition({
    version: 1,
    filter: JSON.parse(raw),
    sort: null,
    search: null,
    myRecords: false,
    columns: [],
  }).filter ?? undefined;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const [{ app, object }, orgId] = await Promise.all([context.params, getOrgId()]);
    const url = new URL(request.url);
    const firstValue = url.searchParams.get("first");
    const sortField = url.searchParams.get("sort");
    const direction = url.searchParams.get("direction");
    if (direction !== null && direction !== "asc" && direction !== "desc") {
      return NextResponse.json({ error: "sort direction must be asc or desc" }, { status: 400 });
    }
    const result = await readRecordList({
      orgId,
      appId: app,
      objectApiName: object,
      first: firstValue === null ? undefined : Number(firstValue),
      after: url.searchParams.get("after"),
      search: url.searchParams.get("q"),
      sort: sortField
        ? { field: sortField, direction: direction === "desc" ? "desc" : "asc" }
        : undefined,
      filters: filtersFrom(url),
      filter: filterFrom(url),
      myRecords: url.searchParams.get("mine") === "true",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("record filters"))) {
      return NextResponse.json({ error: "record filters are malformed" }, { status: 400 });
    }
    return recordsApiError(error);
  }
}
