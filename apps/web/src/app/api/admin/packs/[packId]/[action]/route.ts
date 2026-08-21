import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";
import {
  isPackReadAction,
  isPackWriteAction,
  requestPackWorker,
  validPackId,
} from "@/lib/solution-packs";

type RouteContext = {
  params: Promise<{ packId: string; action: string }>;
};

const MAX_BODY_BYTES = 64 * 1024;

export async function GET(_request: NextRequest, context: RouteContext) {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  const { packId, action } = await context.params;
  if (!validPackId(packId) || !isPackReadAction(action)) {
    return NextResponse.json({ error: "unknown pack operation" }, { status: 404 });
  }
  try {
    const result = await requestPackWorker(
      `/admin/packs/${encodeURIComponent(packId)}/${action}`,
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  const { packId, action } = await context.params;
  if (!validPackId(packId) || !isPackWriteAction(action)) {
    return NextResponse.json({ error: "unknown pack operation" }, { status: 404 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request is too large" }, { status: 413 });
  }
  let parsed: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "request is too large" }, { status: 413 });
    }
    parsed = raw ? JSON.parse(raw) as unknown : {};
  } catch {
    return NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json({ error: "request body must be an object" }, { status: 400 });
  }
  try {
    const body = {
      ...(parsed as Record<string, unknown>),
      actorUserId: allowed.userId,
      idempotencyKey:
        typeof (parsed as Record<string, unknown>).idempotencyKey === "string"
          ? (parsed as Record<string, unknown>).idempotencyKey
          : randomUUID(),
    };
    const result = await requestPackWorker(
      `/admin/packs/${encodeURIComponent(packId)}/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
