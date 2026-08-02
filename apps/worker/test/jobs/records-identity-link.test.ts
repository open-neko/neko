import { describe, expect, it, vi } from "vitest";
import { runRecordsIdentityLink } from "../../src/jobs/records-identity-link";

describe("records identity link job", () => {
  it("passes only the trusted scoped identity to the records mapper", async () => {
    const link = vi.fn(async () => ({ linked: 2, conflicts: 1 }));
    const pool = {} as never;
    await expect(
      runRecordsIdentityLink(
        pool,
        { orgId: "org-a", appUserId: "user-1", email: "alice@example.com" },
        link,
      ),
    ).resolves.toEqual({ linked: 2, conflicts: 1 });
    expect(link).toHaveBeenCalledWith(pool, {
      orgId: "org-a",
      appUserId: "user-1",
      email: "alice@example.com",
    });
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
});
