import { NextRequest, NextResponse } from "next/server";
import { getCurrentActor } from "@/lib/actor";
import {
  AppChatContextError,
  resolveAppChatContext,
} from "@/lib/app-chat-context";
import { getOrgId } from "@/lib/db";
import { recordsApiError } from "@/lib/records-api";
import {
  createWorkThread,
  listWorkThreads,
} from "@/lib/work-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ app: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const [{ app }, orgId, actor] = await Promise.all([
      context.params,
      getOrgId(),
      getCurrentActor(),
    ]);
    const resolved = await resolveAppChatContext({
      orgId,
      appId: app,
      actorRole: actor.role,
      recordContext: null,
    });
    const threads = await listWorkThreads(orgId, "web", actor.userId, {
      surface: "app",
      appId: resolved.appContext.appId,
    });
    return NextResponse.json({ threads });
  } catch (error) {
    return recordsApiError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const body = await request.json().catch(() => ({}));
    const [{ app }, orgId, actor] = await Promise.all([
      context.params,
      getOrgId(),
      getCurrentActor(),
    ]);
    const resolved = await resolveAppChatContext({
      orgId,
      appId: app,
      actorRole: actor.role,
      recordContext: body.recordContext,
    });
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 160) : "";
    const thread = await createWorkThread(
      orgId,
      title,
      "web",
      actor.userId,
      {
        appContext: resolved.appContext,
        ...(resolved.recordContext
          ? { recordContext: resolved.recordContext }
          : {}),
      },
    );
    return NextResponse.json({ thread });
  } catch (error) {
    if (error instanceof AppChatContextError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return recordsApiError(error);
  }
}
