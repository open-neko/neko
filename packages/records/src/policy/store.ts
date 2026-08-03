import type { Pool, PoolClient } from "pg";
import { validateRecordIdentifier } from "../naming";
import type { RecordPolicyGrant } from "./evaluate";

type PermissionRow = {
  app_id: string;
  role: string;
  object_api_name: string;
  can_read: boolean;
  can_create: boolean;
  can_update: boolean;
  can_delete: boolean;
};

/**
 * C7's only direct reader of engine.record_permission. Registry snapshots,
 * route guards, the write executor, and GraphJin projection all consume the
 * same typed grants returned here.
 */
export async function loadRecordPolicyGrants(
  client: Pool | PoolClient,
  input: { orgId: string; appId?: string },
): Promise<RecordPolicyGrant[]> {
  if (!input.orgId.trim()) throw new Error("record permission read requires an org id");
  const result = input.appId
    ? await client.query<PermissionRow>(
        `select app_id, role, object_api_name,
                can_read, can_create, can_update, can_delete
         from engine.record_permission
         where org_id = $1 and app_id = $2
         order by role, object_api_name`,
        [input.orgId, input.appId],
      )
    : await client.query<PermissionRow>(
        `select app_id, role, object_api_name,
                can_read, can_create, can_update, can_delete
         from engine.record_permission
         where org_id = $1
         order by app_id, role, object_api_name`,
        [input.orgId],
      );
  return result.rows.map((row) => ({
    appId: row.app_id,
    role: row.role,
    objectApiName: validateRecordIdentifier(row.object_api_name),
    canRead: row.can_read,
    canCreate: row.can_create,
    canUpdate: row.can_update,
    canDelete: row.can_delete,
  }));
}
