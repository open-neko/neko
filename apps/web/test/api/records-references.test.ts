import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  lookup: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getOrgId: mocks.getOrgId }));
vi.mock("@/lib/records", () => ({ readRecordReferenceOptions: mocks.lookup }));
vi.mock("@/lib/records-api", async () => {
  const { NextResponse } = await import("next/server");
  return { recordsApiError: () => NextResponse.json({ error: "failed" }, { status: 503 }) };
});

import { GET } from "@/app/api/a/[app]/references/[object]/route";

const context = { params: Promise.resolve({ app: "crm", object: "account" }) };

describe("record reference lookup route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds the app, target object, organization, and search text", async () => {
    mocks.lookup.mockResolvedValue([{ id: "account-1", label: "Meridian" }]);
    const response = await GET(
      new Request("http://localhost/api/a/crm/references/account?q=Meridian"),
      context,
    );
    expect(await response.json()).toEqual({
      options: [{ id: "account-1", label: "Meridian" }],
    });
    expect(mocks.lookup).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "crm",
      objectApiName: "account",
      search: "Meridian",
    });
  });
});
