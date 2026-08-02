import type { Pool, PoolClient } from "pg";
import type { RecordsGraphjinRole } from "../graphjin/client";

export type RecordsActorSyncInput = {
  orgId: string;
  userId: string;
  role: Exclude<RecordsGraphjinRole, "service">;
};

function canonicalIdentity(value: string, label: string): string {
  if (!value.trim() || value !== value.trim() || value.length > 500) {
    throw new Error(`records actor ${label} must be a canonical non-empty string`);
  }
  return value;
}

/**
 * Keep GraphJin's role lookup in step with the authenticated metadata actor.
 * This only writes engine-owned policy state; application rows remain behind
 * GraphJin and the governed action executor.
 */
export async function syncRecordsActor(
  client: Pool | PoolClient,
  input: RecordsActorSyncInput,
): Promise<void> {
  const orgId = canonicalIdentity(input.orgId, "org id");
  const userId = canonicalIdentity(input.userId, "user id");
  if (input.role !== "admin" && input.role !== "member") {
    throw new Error("records actor role must be admin or member");
  }
  await client.query(
    `insert into engine.actor (org_id, user_id, role)
     values ($1, $2, $3)
     on conflict (org_id, user_id) do update
     set role = excluded.role, disabled_at = null, synced_at = now()`,
    [orgId, userId, input.role],
  );
}

