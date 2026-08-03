import { NextResponse } from "next/server";
import {
  RecordReadPermissionError,
  RecordReadTargetError,
  RecordSavedViewError,
  RecordSavedViewPermissionError,
  RecordsGraphjinRequestError,
} from "@neko/records";
import { RecordAppRouteError } from "@/lib/records";

export function recordsApiError(error: unknown): NextResponse {
  if (error instanceof RecordAppRouteError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof RecordReadPermissionError) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (error instanceof RecordReadTargetError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof RecordSavedViewPermissionError) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (error instanceof RecordSavedViewError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof RecordsGraphjinRequestError) {
    return NextResponse.json(
      { error: "The records data plane is unavailable. No fallback read was attempted." },
      { status: 503 },
    );
  }
  console.error("[records-api] request failed", error);
  return NextResponse.json(
    { error: "The records service is unavailable." },
    { status: 503 },
  );
}
