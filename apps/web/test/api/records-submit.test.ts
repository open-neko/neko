import { describe, expect, it, vi, beforeEach } from "vitest";
import { RecordValidationError } from "@neko/records";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  submit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getOrgId: mocks.getOrgId }));

vi.mock("@/lib/records-actions", () => {
  class RecordFormPolicyError extends Error {}
  class RecordFormExecutionError extends Error {
    constructor(
      message: string,
      readonly actionRequestId: string,
    ) {
      super(message);
    }
  }
  return {
    RecordFormPolicyError,
    RecordFormExecutionError,
    submitRecordFormAction: mocks.submit,
  };
});

vi.mock("@/lib/records-api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    recordsApiError: () =>
      NextResponse.json({ error: "records unavailable" }, { status: 503 }),
  };
});

import {
  RecordFormExecutionError,
  RecordFormPolicyError,
} from "@/lib/records-actions";
import { POST } from "@/app/api/a/[app]/[object]/submit/route";

const context = {
  params: Promise.resolve({ app: "operations", object: "work_order" }),
};

function request(body: unknown): Request {
  return new Request("http://localhost/api/a/operations/work_order/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("records form submit route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only the route target and form payload to the governed action layer", async () => {
    mocks.submit.mockResolvedValue({
      status: "executed",
      actionRequestId: "request-1",
      recordId: "record-1",
      policy: "record_mutation_default",
    });

    const response = await POST(
      request({ operation: "create", fields: { subject: "Inspect lights" } }),
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "executed",
      recordId: "record-1",
    });
    expect(mocks.submit).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      operation: "create",
      recordId: undefined,
      fields: { subject: "Inspect lights" },
      expected: undefined,
    });
  });

  it("returns 202 without claiming success when execution remains queued", async () => {
    mocks.submit.mockResolvedValue({
      status: "queued",
      actionRequestId: "request-2",
      recordId: null,
      policy: "record_mutation_default",
    });

    const response = await POST(
      request({
        operation: "update",
        id: "work-1",
        fields: { status: "Complete" },
        expected: { status: "In progress" },
      }),
      context,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      actionRequestId: "request-2",
    });
  });

  it("maps validation, policy, and execution failures to typed responses", async () => {
    mocks.submit.mockRejectedValueOnce(
      new RecordValidationError([
        { field: "subject", code: "required", message: "is required" },
      ]),
    );
    const invalid = await POST(
      request({ operation: "create", fields: {} }),
      context,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      issues: [{ field: "subject", message: "is required" }],
    });

    mocks.submit.mockRejectedValueOnce(new RecordFormPolicyError("policy denied"));
    const denied = await POST(
      request({ operation: "create", fields: { subject: "x" } }),
      context,
    );
    expect(denied.status).toBe(403);

    mocks.submit.mockRejectedValueOnce(
      new RecordFormExecutionError("worker rejected mutation", "request-3"),
    );
    const failed = await POST(
      request({ operation: "create", fields: { subject: "x" } }),
      context,
    );
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toEqual({
      error: "worker rejected mutation",
      actionRequestId: "request-3",
    });
  });

  it("rejects unknown operations before creating an action request", async () => {
    const response = await POST(
      request({ operation: "delete", fields: {} }),
      context,
    );
    expect(response.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
