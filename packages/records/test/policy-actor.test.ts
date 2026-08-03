import { describe, expect, it, vi } from "vitest";
import { syncRecordsActor } from "../src/policy/actor";

describe("records actor sync", () => {
  it("upserts the authenticated human role into engine policy state", async () => {
    const query = vi.fn().mockResolvedValue({});
    await syncRecordsActor({ query } as never, {
      orgId: "org-a",
      userId: "member-1",
      role: "member",
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("engine.actor"), [
      "org-a",
      "member-1",
      "member",
    ]);
    expect(query.mock.calls[0]?.[0]).toContain("disabled_at = null");
  });

  it("rejects ambiguous identities", async () => {
    const query = vi.fn();
    await expect(
      syncRecordsActor({ query } as never, {
        orgId: " org-a",
        userId: "member-1",
        role: "member",
      }),
    ).rejects.toThrow(/canonical/);
    expect(query).not.toHaveBeenCalled();
  });
});

