import type { Pool } from "pg";
import type { RecordsIdentityLinkPayload } from "@neko/db/jobs";
import {
  linkIdentityMappingsForUser,
  listLinkedIdentityScopesForUser,
  type LinkedIdentityScope,
} from "@neko/records";
import { inProcessControlPlane } from "@neko/llm/work";

export type LazyIdentityBackfillScheduler = (
  payload: RecordsIdentityLinkPayload,
  scopes: LinkedIdentityScope[],
) => Promise<number>;

export async function scheduleLazyIdentityBackfills(
  payload: RecordsIdentityLinkPayload,
  scopes: LinkedIdentityScope[],
): Promise<number> {
  let queued = 0;
  for (const scope of scopes) {
    const target = `record-identity:${scope.appId}/${scope.sourceInstanceId}/${scope.sourceUserId}`;
    const decision = await inProcessControlPlane.evaluateActionPolicy({
      orgId: payload.orgId,
      scope: "internal",
      kind: "records_identity_backfill_lazy",
      target,
      riskLevel: "low",
    });
    if (decision.decision !== "allow") continue;
    const summary = `Propagate the linked identity ${scope.sourceUserId} into ${scope.appId} ownership`;
    const request = await inProcessControlPlane.createActionRequest({
      orgId: payload.orgId,
      scope: "internal",
      kind: "records_identity_backfill_lazy",
      target,
      payload: {
        app: scope.appId,
        source_instance_id: scope.sourceInstanceId,
        source_user_id: scope.sourceUserId,
        linked_app_user_id: payload.appUserId,
      },
      riskLevel: "low",
      status: "approved",
      policyId: decision.policy.id,
      summary,
      intent: `${summary} after an unambiguous SSO email match.`,
      actorUserId: payload.appUserId,
      actorRole: null,
      actorBackend: "records-identity-link",
    });
    await inProcessControlPlane.enqueueActionExecute({
      orgId: payload.orgId,
      actionRequestId: request.id,
    });
    queued += 1;
  }
  return queued;
}

/** Lazy SSO linking runs in the worker so login latency never includes records I/O. */
export async function runRecordsIdentityLink(
  pool: Pool,
  payload: RecordsIdentityLinkPayload,
  link: typeof linkIdentityMappingsForUser = linkIdentityMappingsForUser,
  listScopes: typeof listLinkedIdentityScopesForUser = listLinkedIdentityScopesForUser,
  scheduleBackfills: LazyIdentityBackfillScheduler = scheduleLazyIdentityBackfills,
): Promise<{ linked: number; conflicts: number; backfillsQueued: number }> {
  if (!payload.orgId.trim() || !payload.appUserId.trim() || !payload.email.trim()) {
    throw new Error("records identity link job requires org, user, and email");
  }
  const result = await link(pool, payload);
  const scopes = await listScopes(pool, {
    orgId: payload.orgId,
    appUserId: payload.appUserId,
  });
  const backfillsQueued = await scheduleBackfills(payload, scopes);
  return { ...result, backfillsQueued };
}
