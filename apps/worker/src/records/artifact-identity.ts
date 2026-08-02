import type { Pool } from "pg";
import { action_request, and, app_user, db, eq, sql } from "@neko/db";
import { inProcessControlPlane } from "@neko/llm/work";
import { getActionRequest } from "@neko/llm/workflows";
import {
  readImportedSourceUsers,
  reconcileImportedIdentities,
  type IdentityAppUser,
  type IdentityReconciliationResult,
  type ImportedSourceUsersResult,
  type RecordsGraphjinTransport,
} from "@neko/records";

export type ArtifactIdentityDependencies = {
  readUsers: (
    pool: Pool,
    input: Parameters<typeof readImportedSourceUsers>[1],
  ) => Promise<ImportedSourceUsersResult>;
  listAppUsers: (orgId: string) => Promise<IdentityAppUser[]>;
  reconcile: (
    pool: Pool,
    input: Parameters<typeof reconcileImportedIdentities>[1],
  ) => Promise<IdentityReconciliationResult>;
  prepareBackfill: typeof prepareIdentityBackfill;
};

async function prepareIdentityBackfill(input: {
  orgId: string;
  appId: string;
  sourceInstanceId: string;
  manifestHash: string;
  importActionRequestId: string;
}): Promise<{ id: string; status: string }> {
  const target = `record-identity-import:${input.appId}/${input.sourceInstanceId}/${input.manifestHash}`;
  const [decision, importRequest] = await Promise.all([
    inProcessControlPlane.evaluateActionPolicy({
      orgId: input.orgId,
      scope: "internal",
      kind: "records_identity_backfill_import",
      target,
      riskLevel: "low",
    }),
    getActionRequest(input.orgId, input.importActionRequestId),
  ]);
  if (decision.decision !== "allow") {
    throw new Error("artifact identity backfill is not allowed by policy");
  }
  if (!importRequest || importRequest.actorRole !== "admin") {
    throw new Error("artifact identity backfill is missing its approved admin import");
  }
  return db().transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.orgId}:${target}`}, 0))`,
    );
    const existing = await transaction
      .select({ id: action_request.id, status: action_request.status })
      .from(action_request)
      .where(
        and(
          eq(action_request.org_id, input.orgId),
          eq(action_request.kind, "records_identity_backfill_import"),
          eq(action_request.target, target),
        ),
      )
      .orderBy(sql`${action_request.created_at} desc`)
      .limit(1);
    if (existing[0] && existing[0].status !== "failed") return existing[0];
    const summary = `Backfill ${input.appId} ownership from verified imported identities`;
    const created = await inProcessControlPlane.createActionRequest({
      orgId: input.orgId,
      scope: "internal",
      kind: "records_identity_backfill_import",
      target,
      payload: {
        app: input.appId,
        source_instance_id: input.sourceInstanceId,
        import_action_request_id: input.importActionRequestId,
      },
      riskLevel: "low",
      status: "approved",
      policyId: decision.policy.id,
      summary,
      intent: `${summary}; only unambiguous linked mappings are eligible.`,
      actorUserId: importRequest.actorUserId,
      actorRole: "admin",
      actorBackend: "records-artifact-import",
    });
    return { id: created.id, status: "approved" };
  });
}

export const defaultArtifactIdentityDependencies: ArtifactIdentityDependencies = {
  readUsers: readImportedSourceUsers,
  listAppUsers: async (orgId) => {
    const users = await db()
      .select({ id: app_user.id, email: app_user.email, disabledAt: app_user.disabled_at })
      .from(app_user)
      .where(eq(app_user.org_id, orgId));
    return users.map((user) => ({
      id: user.id,
      email: user.email,
      disabled: user.disabledAt !== null,
    }));
  },
  reconcile: reconcileImportedIdentities,
  prepareBackfill: prepareIdentityBackfill,
};

export async function reconcileArtifactIdentities(
  pool: Pool,
  input: {
    orgId: string;
    appId: string;
    sourceInstanceId: string;
    manifestHash: string;
    importActionRequestId: string;
    graphjin: RecordsGraphjinTransport;
    serviceToken: string;
  },
  dependencies: ArtifactIdentityDependencies = defaultArtifactIdentityDependencies,
): Promise<{
  report: Record<string, unknown>;
  action: { id: string; status: string } | null;
}> {
  const imported = await dependencies.readUsers(pool, {
    orgId: input.orgId,
    appId: input.appId,
    graphjin: input.graphjin,
    token: input.serviceToken,
    sourceObject: "User",
  });
  if (!imported.found) {
    return { report: { status: "not_available" }, action: null };
  }
  const appUsers = await dependencies.listAppUsers(input.orgId);
  const reconciliation = await dependencies.reconcile(pool, {
    orgId: input.orgId,
    sourceInstanceId: input.sourceInstanceId,
    appId: input.appId,
    sourceUsers: imported.users,
    appUsers,
  });
  const action =
    reconciliation.linked > 0
      ? await dependencies.prepareBackfill(input)
      : null;
  return {
    report: {
      status:
        reconciliation.unlinked > 0 ||
        reconciliation.conflicts > 0 ||
        imported.invalidEmails > 0
          ? "needs_attention"
          : "reconciled",
      linked: reconciliation.linked,
      unlinked: reconciliation.unlinked,
      conflicts: reconciliation.conflicts,
      ignored: reconciliation.ignored,
      invalid_emails: imported.invalidEmails,
      ...(imported.invalidEmailSourceUserIds.length > 0
        ? { invalid_email_source_user_ids: imported.invalidEmailSourceUserIds }
        : {}),
      ...(action ? { backfill_action_id: action.id } : {}),
    },
    action,
  };
}
