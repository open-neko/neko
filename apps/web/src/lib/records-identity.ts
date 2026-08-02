import "server-only";

import { and, app_user, asc, db, eq, isNull } from "@neko/db";
import {
  decideIdentityMapping,
  listIdentityMappings,
  type IdentityMappingStatus,
} from "@neko/records";
import { getCurrentActor } from "@/lib/actor";
import { getWebRecordsPool, loadRecordAppShell } from "@/lib/records";

export type RecordIdentityAdminUser = {
  id: string;
  email: string;
  name: string | null;
};

export type RecordIdentityAdminMapping = {
  sourceInstanceId: string;
  sourceUserId: string;
  sourceEmail: string;
  sourceName: string | null;
  sourceIsActive: boolean | null;
  appUserId: string | null;
  appUser: RecordIdentityAdminUser | null;
  status: IdentityMappingStatus;
  linkedAt: string | null;
  updatedAt: string;
};

export type RecordIdentityAdminModel = {
  appId: string;
  appLabel: string;
  fallbackHref: string;
  mappings: RecordIdentityAdminMapping[];
  users: RecordIdentityAdminUser[];
  counts: Record<IdentityMappingStatus | "all", number>;
};

export class RecordIdentityWebPermissionError extends Error {
  readonly code = "records_identity_admin_required";

  constructor(message = "Identity mapping requires an administrator.") {
    super(message);
    this.name = "RecordIdentityWebPermissionError";
  }
}

export class RecordIdentityWebInputError extends Error {
  readonly code = "records_identity_input_invalid";

  constructor(message: string) {
    super(message);
    this.name = "RecordIdentityWebInputError";
  }
}

async function requireIdentityAdmin(): Promise<void> {
  const actor = await getCurrentActor();
  if (actor.role !== "admin") throw new RecordIdentityWebPermissionError();
}

async function activeAppUsers(orgId: string): Promise<RecordIdentityAdminUser[]> {
  return db()
    .select({ id: app_user.id, email: app_user.email, name: app_user.name })
    .from(app_user)
    .where(and(eq(app_user.org_id, orgId), isNull(app_user.disabled_at)))
    .orderBy(asc(app_user.name), asc(app_user.email), asc(app_user.id));
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export async function getRecordIdentityAdminModel(input: {
  orgId: string;
  appId: string;
  status?: IdentityMappingStatus;
}): Promise<RecordIdentityAdminModel> {
  await requireIdentityAdmin();
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  const [allMappings, users] = await Promise.all([
    listIdentityMappings(getWebRecordsPool(), {
      orgId: input.orgId,
      appId: shell.snapshot.app.appId,
    }),
    activeAppUsers(input.orgId),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const counts: Record<IdentityMappingStatus | "all", number> = {
    all: allMappings.length,
    linked: 0,
    unlinked: 0,
    conflict: 0,
    ignored: 0,
  };
  for (const mapping of allMappings) counts[mapping.status] += 1;
  const mappings = allMappings
    .filter((mapping) => !input.status || mapping.status === input.status)
    .map(
      (mapping): RecordIdentityAdminMapping => ({
        sourceInstanceId: mapping.sourceInstanceId,
        sourceUserId: mapping.sourceUserId,
        sourceEmail: mapping.sourceEmail,
        sourceName: mapping.sourceName,
        sourceIsActive: mapping.sourceIsActive,
        appUserId: mapping.appUserId,
        appUser: mapping.appUserId ? usersById.get(mapping.appUserId) ?? null : null,
        status: mapping.status,
        linkedAt: iso(mapping.linkedAt),
        updatedAt: iso(mapping.updatedAt)!,
      }),
    );
  const fallbackObject = shell.snapshot.objects.find((object) => object.archivedAt === null);
  return {
    appId: shell.snapshot.app.appId,
    appLabel: shell.snapshot.app.label,
    fallbackHref: fallbackObject
      ? `/a/${shell.snapshot.app.appId}/${fallbackObject.apiName}`
      : `/a/${shell.snapshot.app.appId}`,
    mappings,
    users,
    counts,
  };
}

export async function decideRecordIdentityForWeb(input: {
  orgId: string;
  appId: string;
  sourceInstanceId: string;
  sourceUserId: string;
  decision: "link" | "ignore";
  appUserId?: string;
}): Promise<RecordIdentityAdminMapping> {
  await requireIdentityAdmin();
  if (input.decision !== "link" && input.decision !== "ignore") {
    throw new RecordIdentityWebInputError("Choose link or ignore.");
  }
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  let selectedUser: RecordIdentityAdminUser | null = null;
  if (input.decision === "link") {
    if (typeof input.appUserId !== "string" || !input.appUserId.trim()) {
      throw new RecordIdentityWebInputError("Choose an active OpenNeko user.");
    }
    const users = await db()
      .select({ id: app_user.id, email: app_user.email, name: app_user.name })
      .from(app_user)
      .where(
        and(
          eq(app_user.org_id, input.orgId),
          eq(app_user.id, input.appUserId.trim()),
          isNull(app_user.disabled_at),
        ),
      )
      .limit(1);
    selectedUser = users[0] ?? null;
    if (!selectedUser) {
      throw new RecordIdentityWebInputError("That OpenNeko user is unavailable.");
    }
  }
  const mapping = await decideIdentityMapping(getWebRecordsPool(), {
    orgId: input.orgId,
    appId: shell.snapshot.app.appId,
    sourceInstanceId: input.sourceInstanceId,
    sourceUserId: input.sourceUserId,
    decision: input.decision,
    appUserId: selectedUser?.id,
  });
  return {
    sourceInstanceId: mapping.sourceInstanceId,
    sourceUserId: mapping.sourceUserId,
    sourceEmail: mapping.sourceEmail,
    sourceName: mapping.sourceName,
    sourceIsActive: mapping.sourceIsActive,
    appUserId: mapping.appUserId,
    appUser: selectedUser,
    status: mapping.status,
    linkedAt: iso(mapping.linkedAt),
    updatedAt: iso(mapping.updatedAt)!,
  };
}
