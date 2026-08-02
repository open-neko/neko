import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  restore: vi.fn(),
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
    submitRecordRestoreAction: mocks.restore,
  };
});

vi.mock("@/lib/records-api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    recordsApiError: () =>
      NextResponse.json({ error: "records unavailable" }, { status: 503 }),
  };
});

import { POST } from "@/app/api/a/[app]/[object]/restore/[id]/route";
import {
  RecordFormExecutionError,
  RecordFormPolicyError,
} from "@/lib/records-actions";

const context = {
  params: Promise.resolve({
    app: "operations",
    object: "work_order",
    id: "work-1",
  }),
};

describe("records restore route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes only the scoped route target to the governed restore layer", async () => {
    mocks.restore.mockResolvedValue({
      status: "executed",
      actionRequestId: "request-1",
      recordId: "work-1",
      policy: "record_mutation_default",
    });

    const response = await POST(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "executed",
      recordId: "work-1",
    });
    expect(mocks.restore).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      recordId: "work-1",
    });
  });

  it("preserves queued status and maps policy and execution failures", async () => {
    mocks.restore.mockResolvedValueOnce({
      status: "queued",
      actionRequestId: "request-2",
      recordId: "work-1",
      policy: "record_mutation_default",
    });
    expect((await POST(new Request("http://localhost"), context)).status).toBe(202);

    mocks.restore.mockRejectedValueOnce(new RecordFormPolicyError("policy denied"));
    expect((await POST(new Request("http://localhost"), context)).status).toBe(403);

    mocks.restore.mockRejectedValueOnce(
      new RecordFormExecutionError("worker rejected restore", "request-3"),
    );
    const failed = await POST(new Request("http://localhost"), context);
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toEqual({
      error: "worker rejected restore",
      actionRequestId: "request-3",
    });
  });
});
