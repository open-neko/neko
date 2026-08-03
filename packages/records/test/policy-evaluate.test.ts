import { describe, expect, it } from "vitest";
import { validateRecordIdentifier } from "../src/naming";
import {
  evaluateRecordObjectPermission,
  evaluateRecordPermission,
} from "../src/policy/evaluate";
import { projectRecordsGraphjinRoles } from "../src/policy/graphjin";
import { recordsPolicyFixture } from "./policy-fixture";

describe("evaluateRecordPermission", () => {
  const objectApiName = validateRecordIdentifier("contact");
  const grant = {
    appId: "crm",
    role: "member",
    objectApiName,
    canRead: true,
    canCreate: true,
    canUpdate: true,
    canDelete: false,
  };
  const object = {
    appId: "crm",
    apiName: objectApiName,
    visibility: "owner" as const,
    archived: false,
  };
  const actor = { userId: "user-1", role: "member" as const };

  it("enforces grants, archives, and member ownership", () => {
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "read", row: { ownerUserId: "user-1" } }),
    ).toBe(true);
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "read", row: { ownerUserId: "user-2" } }),
    ).toBe(false);
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "delete", row: { ownerUserId: "user-1" } }),
    ).toBe(false);
    expect(
      evaluateRecordPermission({ actor, object: { ...object, archived: true }, grant, operation: "read" }),
    ).toBe(false);
  });

  it("allows owner creates only for the actor or an executor-stamped owner", () => {
    expect(evaluateRecordPermission({ actor, object, grant, operation: "create" })).toBe(true);
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "create", row: { ownerUserId: "user-1" } }),
    ).toBe(true);
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "create", row: { ownerUserId: "user-2" } }),
    ).toBe(false);
  });

  it("exposes object capability without weakening row ownership checks", () => {
    expect(
      evaluateRecordObjectPermission({
        actor,
        object,
        grant,
        operation: "read",
      }),
    ).toBe(true);
    expect(
      evaluateRecordPermission({ actor, object, grant, operation: "read" }),
    ).toBe(false);
  });

  it("stays in lockstep with the generated member owner filter", () => {
    const model = recordsPolicyFixture();
    const contact = model.objects.find((candidate) => candidate.apiName === "contact")!;
    const permission = model.permissions.find(
      (candidate) => candidate.role === "member" && candidate.objectApiName === "contact",
    )!;
    const memberRole = projectRecordsGraphjinRoles(model).find((role) => role.name === "member")!;
    const table = memberRole.tables.find((candidate) => candidate.name === "crm__contact")!;

    expect(table.query.filters).toContain("{ owner_user_id: { eq: $user_id } }");
    expect(
      evaluateRecordPermission({
        actor,
        object: {
          appId: contact.appId,
          apiName: contact.apiName,
          visibility: contact.visibility,
          archived: contact.archived,
        },
        grant: permission,
        operation: "read",
        row: { ownerUserId: actor.userId },
      }),
    ).toBe(true);
  });
});
