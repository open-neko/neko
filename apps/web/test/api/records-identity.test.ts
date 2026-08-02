import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  decide: vi.fn(),
  backfill: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getOrgId: mocks.getOrgId }));

vi.mock("@/lib/records-identity", () => {
  class RecordIdentityWebPermissionError extends Error {}
  class RecordIdentityWebInputError extends Error {}
  class RecordIdentityWebExecutionError extends Error {
    constructor(
      message: string,
      readonly actionRequestId: string,
    ) {
      super(message);
    }
  }
  return {
    decideRecordIdentityForWeb: mocks.decide,
    runRecordIdentityBackfillFromWeb: mocks.backfill,
    RecordIdentityWebPermissionError,
    RecordIdentityWebInputError,
    RecordIdentityWebExecutionError,
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
import { POST as backfill } from "@/app/api/a/[app]/identity/backfill/route";
import {
  RecordIdentityWebInputError,
  RecordIdentityWebExecutionError,
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

  it("starts a source-scoped governed ownership backfill", async () => {
    mocks.backfill.mockResolvedValue({
      status: "executed",
      actionRequestId: "request-backfill",
      policy: "records_identity_backfill_default",
      report: { updated: 3 },
    });
    const response = await backfill(request({ sourceInstanceId: "sf-prod" }), context);
    expect(response.status).toBe(200);
    expect(mocks.backfill).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "sf-prod",
    });
  });

  it("returns queued and failed backfill states honestly", async () => {
    mocks.backfill.mockResolvedValueOnce({
      status: "queued",
      actionRequestId: "request-queued",
      policy: "records_identity_backfill_default",
      report: null,
    });
    const queued = await backfill(request({ sourceInstanceId: "sf-prod" }), context);
    expect(queued.status).toBe(202);

    mocks.backfill.mockRejectedValueOnce(
      new RecordIdentityWebExecutionError("worker rejected backfill", "request-failed"),
    );
    const failed = await backfill(request({ sourceInstanceId: "sf-prod" }), context);
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toEqual({
      error: "worker rejected backfill",
      actionRequestId: "request-failed",
    });
  });
});
