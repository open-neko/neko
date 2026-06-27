import { NextResponse } from "next/server";
import { isDenied, requireAdminActor } from "@/lib/admin-auth";
import { getPluginStatus } from "@/lib/auth";

export async function GET() {
  const allowed = await requireAdminActor();
  if (isDenied(allowed)) return allowed;
  const status = await getPluginStatus();
  return NextResponse.json({ status });
}
