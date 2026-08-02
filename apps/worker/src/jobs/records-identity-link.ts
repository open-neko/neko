import type { Pool } from "pg";
import type { RecordsIdentityLinkPayload } from "@neko/db/jobs";
import { linkIdentityMappingsForUser } from "@neko/records";

/** Lazy SSO linking runs in the worker so login latency never includes records I/O. */
export async function runRecordsIdentityLink(
  pool: Pool,
  payload: RecordsIdentityLinkPayload,
  link: typeof linkIdentityMappingsForUser = linkIdentityMappingsForUser,
): Promise<{ linked: number; conflicts: number }> {
  if (!payload.orgId.trim() || !payload.appUserId.trim() || !payload.email.trim()) {
    throw new Error("records identity link job requires org, user, and email");
  }
  return link(pool, payload);
}
