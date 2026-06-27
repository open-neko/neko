import { NextResponse } from "next/server";
import type { RunActor } from "@neko/llm/work";
import { getCurrentActor } from "@/lib/actor";

export function adminOnlyJson(): NextResponse {
  return NextResponse.json({ error: "admin only" }, { status: 403 });
}

/**
 * Admin gate for OpenNeko-native administration routes.
 *
 * getCurrentActor preserves solo/userless mode as admin. When SSO is active,
 * the proxy/session path resolves the signed-in app_user role before handlers
 * get here.
 */
export async function requireAdminActor(): Promise<RunActor | NextResponse> {
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return adminOnlyJson();
  return actor;
}

export function isDenied(
  result: RunActor | NextResponse,
): result is NextResponse {
  return result instanceof Response;
}
