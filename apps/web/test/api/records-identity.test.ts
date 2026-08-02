import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  decide: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getOrgId: mocks.getOrgId }));

vi.mock("@/lib/records-identity", () => {
  class RecordIdentityWebPermissionError extends Error {}
  class RecordIdentityWebInputError extends Error {}
  return {
    decideRecordIdentityForWeb: mocks.decide,
    RecordIdentityWebPermissionError,
    RecordIdentityWebInputError,
  };
});

vi.mock("@/lib/records-api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    recordsApiError: () =>
      NextResponse.json({ error: "records unavailable" }, { status: 503 }),
  };
});

vi.mock("@neko/records", () => {
  class IdentityMappingError extends Error {}
  return { IdentityMappingError };
});

import { POST } from "@/app/api/a/[app]/identity/decision/route";
import {
  RecordIdentityWebInputError,
  RecordIdentityWebPermissionError,
} from "@/lib/records-identity";

const context = { params: Promise.resolve({ app: "crm" }) };

function request(body: unknown): Request {
  return new Request("http://localhost/api/a/crm/identity/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("records identity decision route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes an exact organization, app, source instance, and user scope", async () => {
    const mapping = {
      sourceInstanceId: "sf-prod",
      sourceUserId: "005-alice",
      status: "linked",
      appUserId: "user-alice",
    };
    mocks.decide.mockResolvedValue(mapping);

    const response = await POST(
      request({
        sourceInstanceId: " sf-prod ",
        sourceUserId: " 005-alice ",
        decision: "link",
        appUserId: " user-alice ",
      }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mapping });
    expect(mocks.decide).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "sf-prod",
      sourceUserId: "005-alice",
      decision: "link",
      appUserId: "user-alice",
    });
  });

  it("does not accept missing source scope or invented decisions", async () => {
    const missing = await POST(
      request({ sourceInstanceId: "", sourceUserId: "005-a", decision: "ignore" }),
      context,
    );
    expect(missing.status).toBe(400);

    const invalid = await POST(
      request({ sourceInstanceId: "sf-prod", sourceUserId: "005-a", decision: "merge" }),
      context,
    );
    expect(invalid.status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("maps authorization and domain validation errors without claiming success", async () => {
    mocks.decide.mockRejectedValueOnce(new RecordIdentityWebPermissionError("admin only"));
    const denied = await POST(
      request({ sourceInstanceId: "sf-prod", sourceUserId: "005-a", decision: "ignore" }),
      context,
    );
    expect(denied.status).toBe(403);

    mocks.decide.mockRejectedValueOnce(new RecordIdentityWebInputError("user unavailable"));
    const invalid = await POST(
      request({
        sourceInstanceId: "sf-prod",
        sourceUserId: "005-a",
        decision: "link",
        appUserId: "user-a",
      }),
      context,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: "user unavailable" });
  });
});
