import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  create: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@neko/llm/work", () => ({
  inProcessControlPlane: {
    evaluateActionPolicy: mocks.policy,
    createActionRequest: mocks.create,
    enqueueActionExecute: mocks.enqueue,
  },
}));

import {
  runRecordsIdentityLink,
  scheduleLazyIdentityBackfills,
} from "../../src/jobs/records-identity-link";

describe("records identity link job", () => {
  it("passes only the trusted scoped identity to the records mapper", async () => {
    const link = vi.fn(async () => ({ linked: 2, conflicts: 1 }));
    const listScopes = vi.fn(async () => [
      { appId: "crm", sourceInstanceId: "sf-prod", sourceUserId: "005-alice" },
    ]);
    const schedule = vi.fn(async () => 1);
    const pool = {} as never;
    await expect(
      runRecordsIdentityLink(
        pool,
        { orgId: "org-a", appUserId: "user-1", email: "alice@example.com" },
        link,
        listScopes,
        schedule,
      ),
    ).resolves.toEqual({ linked: 2, conflicts: 1, backfillsQueued: 1 });
    expect(link).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      appUserId: "user-1",
      email: "alice@example.com",
    });
    expect(listScopes).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      appUserId: "user-1",
    });
    expect(schedule).toHaveBeenCalledWith(
      { orgId: "org-a", appUserId: "user-1", email: "alice@example.com" },
      [{ appId: "crm", sourceInstanceId: "sf-prod", sourceUserId: "005-alice" }],
    );
  });

  it("rejects incomplete jobs before touching records", async () => {
    const link = vi.fn();
    await expect(
      runRecordsIdentityLink(
        {} as never,
        { orgId: "org-a", appUserId: "", email: "alice@example.com" },
        link,
      ),
    ).rejects.toThrow(/requires org, user, and email/);
    expect(link).not.toHaveBeenCalled();
  });

  it("journals and queues only policy-approved exact lazy backfills", async () => {
    mocks.policy
      .mockResolvedValueOnce({
        decision: "allow",
        policy: { id: "policy-1", name: "lazy" },
      })
      .mockResolvedValueOnce({ decision: "deny", reason: "disabled" });
    mocks.create.mockResolvedValue({ id: "action-1" });
    mocks.enqueue.mockResolvedValue(undefined);
    await expect(
      scheduleLazyIdentityBackfills(
        { orgId: "org-a", appUserId: "user-1", email: "alice@example.com" },
        [
          { appId: "crm", sourceInstanceId: "sf-prod", sourceUserId: "005-a" },
          { appId: "crm", sourceInstanceId: "sf-sandbox", sourceUserId: "005-b" },
        ],
      ),
    ).resolves.toBe(1);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        kind: "records_identity_backfill_lazy",
        status: "approved",
        actorUserId: "user-1",
        actorBackend: "records-identity-link",
        payload: {
          app: "crm",
          source_instance_id: "sf-prod",
          source_user_id: "005-a",
          linked_app_user_id: "user-1",
        },
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith({
      orgId: "org-a",
      actionRequestId: "action-1",
    });
  });
});
