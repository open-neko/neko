import type { RecordIdentifier } from "../types";

export const RECORD_HUMAN_ROLES = ["admin", "member"] as const;

export type RecordHumanRole = (typeof RECORD_HUMAN_ROLES)[number];
export type RecordCrudOperation = "read" | "create" | "update" | "delete";

export type RecordPolicyActor = {
  userId: string;
  role: RecordHumanRole;
};

export type RecordPolicyObject = {
  appId: string;
  apiName: RecordIdentifier;
  visibility: "org" | "owner";
  archived: boolean;
};

export type RecordPolicyGrant = {
  appId: string;
  role: string;
  objectApiName: RecordIdentifier;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
};

export type RecordPolicyRow = {
  ownerUserId: string | null;
};

export function selectRecordPolicyGrant(
  grants: RecordPolicyGrant[],
  input: { appId: string; role: string; objectApiName: RecordIdentifier },
): RecordPolicyGrant | null {
  return (
    grants.find(
      (grant) =>
        grant.appId === input.appId &&
        grant.role === input.role &&
        grant.objectApiName === input.objectApiName,
    ) ?? null
  );
}

function grantAllows(grant: RecordPolicyGrant, operation: RecordCrudOperation): boolean {
  switch (operation) {
    case "read":
      return grant.canRead;
    case "create":
      return grant.canCreate;
    case "update":
      return grant.canUpdate;
    case "delete":
      return grant.canDelete;
  }
}

/**
 * C7's single permission evaluator. The action executor and route guards use
 * this result; GraphJin receives the same grant/visibility inputs through the
 * mechanical projection in graphjin.ts.
 */
export function evaluateRecordPermission(input: {
  actor: RecordPolicyActor;
  object: RecordPolicyObject;
  grant: RecordPolicyGrant | null;
  operation: RecordCrudOperation;
  row?: RecordPolicyRow;
}): boolean {
  const { actor, object, grant, operation, row } = input;
  if (object.archived || grant === null) return false;
  if (
    grant.appId !== object.appId ||
    grant.role !== actor.role ||
    grant.objectApiName !== object.apiName
  ) {
    return false;
  }
  if (!grantAllows(grant, operation)) return false;

  if (actor.role !== "member" || object.visibility !== "owner") return true;

  // Owner-scoped creates may omit owner_user_id (the executor stamps it), but
  // may never nominate a different owner. Existing-row operations require an
  // exact owner match and fail closed when ownership is absent.
  if (operation === "create") {
    return row === undefined || row.ownerUserId === actor.userId;
  }
  return row?.ownerUserId === actor.userId;
}

export function canReadRecord(
  input: Omit<Parameters<typeof evaluateRecordPermission>[0], "operation">,
): boolean {
  return evaluateRecordPermission({ ...input, operation: "read" });
}

export function canCreateRecord(
  input: Omit<Parameters<typeof evaluateRecordPermission>[0], "operation">,
): boolean {
  return evaluateRecordPermission({ ...input, operation: "create" });
}

export function canUpdateRecord(
  input: Omit<Parameters<typeof evaluateRecordPermission>[0], "operation">,
): boolean {
  return evaluateRecordPermission({ ...input, operation: "update" });
}

export function canDeleteRecord(
  input: Omit<Parameters<typeof evaluateRecordPermission>[0], "operation">,
): boolean {
  return evaluateRecordPermission({ ...input, operation: "delete" });
}
