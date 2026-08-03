import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  reconcileArtifactIdentities,
  type ArtifactIdentityDependencies,
} from "../../src/records/artifact-identity.js";

const pool = {} as Pool;
const input = {
  orgId: "org-a",
  appId: "crm",
  sourceInstanceId: "salesforce-production",
  manifestHash: "a".repeat(64),
  importActionRequestId: "00000000-0000-4000-a000-000000000901",
  graphjin: { execute: vi.fn() },
  serviceToken: "service-token",
};

function dependencies(
  overrides: Partial<ArtifactIdentityDependencies> = {},
): ArtifactIdentityDependencies {
  return {
    readUsers: vi.fn().mockResolvedValue({
      found: true,
      users: [
        { sourceUserId: "005-alice", email: "alice@example.com", name: "Alice" },
        { sourceUserId: "005-shared", email: "shared@example.com", name: "Shared" },
      ],
      invalidEmails: 1,
      invalidEmailSourceUserIds: ["005-invalid"],
    }),
    listAppUsers: vi.fn().mockResolvedValue([
      { id: "user-alice", email: "alice@example.com" },
    ]),
    reconcile: vi.fn().mockResolvedValue({
      mappings: [],
      linked: 1,
      unlinked: 0,
      conflicts: 1,
      ignored: 0,
    }),
    prepareBackfill: vi.fn().mockResolvedValue({ id: "backfill-1", status: "approved" }),
    ...overrides,
  };
}

describe("artifact identity reconciliation", () => {
  it("reports collisions loudly and prepares one governed aggregate backfill", async () => {
    const deps = dependencies();
    await expect(reconcileArtifactIdentities(pool, input, deps)).resolves.toEqual({
      report: {
        status: "needs_attention",
        linked: 1,
        unlinked: 0,
        conflicts: 1,
        ignored: 0,
        invalid_emails: 1,
        invalid_email_source_user_ids: ["005-invalid"],
        backfill_action_id: "backfill-1",
      },
      action: { id: "backfill-1", status: "approved" },
    });
    expect(deps.reconcile).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      sourceInstanceId: "salesforce-production",
      appId: "crm",
      sourceUsers: expect.any(Array),
      appUsers: [{ id: "user-alice", email: "alice@example.com" }],
    });
    expect(deps.prepareBackfill).toHaveBeenCalledWith(input);
  });

  it("does not create identity rows or actions when User was not imported", async () => {
    const deps = dependencies({
      readUsers: vi.fn().mockResolvedValue({
        found: false,
        users: [],
        invalidEmails: 0,
        invalidEmailSourceUserIds: [],
      }),
    });
    await expect(reconcileArtifactIdentities(pool, input, deps)).resolves.toEqual({
      report: { status: "not_available" },
      action: null,
    });
    expect(deps.listAppUsers).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.prepareBackfill).not.toHaveBeenCalled();
  });

  it("leaves unlinked imports action-free", async () => {
    const deps = dependencies({
      reconcile: vi.fn().mockResolvedValue({
        mappings: [],
        linked: 0,
        unlinked: 2,
        conflicts: 0,
        ignored: 0,
      }),
    });
    await expect(reconcileArtifactIdentities(pool, input, deps)).resolves.toMatchObject({
      report: { status: "needs_attention", linked: 0, unlinked: 2 },
      action: null,
    });
    expect(deps.prepareBackfill).not.toHaveBeenCalled();
  });
});
