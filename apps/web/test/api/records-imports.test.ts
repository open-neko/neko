import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgId: vi.fn(async () => "org-a"),
  stage: vi.fn(),
  preview: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getOrgId: mocks.getOrgId }));

vi.mock("@/lib/records-imports", () => {
  class RecordImportWebPermissionError extends Error {}
  class RecordImportWebExecutionError extends Error {
    constructor(
      message: string,
      readonly actionRequestId: string,
    ) {
      super(message);
    }
  }
  return {
    RecordImportWebPermissionError,
    RecordImportWebExecutionError,
    stageRecordImportUpload: mocks.stage,
    previewRecordImport: mocks.preview,
    startRecordImportFromWeb: mocks.start,
    getRecordImportStatusForWeb: mocks.status,
    cancelRecordImportFromWeb: mocks.cancel,
  };
});

vi.mock("@/lib/records-api", async () => {
  const { NextResponse } = await import("next/server");
  return {
    recordsApiError: () =>
      NextResponse.json({ error: "records unavailable" }, { status: 503 }),
  };
});

import { POST as previewImport } from "@/app/api/a/[app]/imports/preview/route";
import { POST as startImport } from "@/app/api/a/[app]/imports/start/route";
import {
  DELETE as cancelImport,
  GET as getImport,
} from "@/app/api/a/[app]/imports/[id]/route";
import {
  RecordImportWebExecutionError,
  RecordImportWebPermissionError,
} from "@/lib/records-imports";

const appContext = { params: Promise.resolve({ app: "operations" }) };
const runContext = {
  params: Promise.resolve({ app: "operations", id: "import-1" }),
};

const plan = {
  version: 1,
  orgId: "org-a",
  appId: "operations",
  objectApiName: "work_order",
  source: {
    path: "imports/upload-a/work-orders.csv",
    name: "work-orders.csv",
    sha256: "a".repeat(64),
    size: 128,
  },
  rowCount: 2,
  columns: [
    {
      sourceColumn: "subject",
      targetField: "subject",
      inferredKind: "text",
      suggestedField: null,
    },
  ],
  sampleRows: [{ subject: "Inspect lights" }],
  duplicateKey: "id",
  batchSize: 100,
  ownerUserId: null,
  emptyTextColumns: [],
  planHash: "b".repeat(64),
};

const run = {
  id: "import-1",
  objectApiName: "work_order",
  sourceName: "work-orders.csv",
  sourceRows: 2,
  status: "running",
  stage: "insert",
  progress: { processed: 1, total: 2 },
  report: null,
  error: null,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:01.000Z",
};

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/api/a/operations/imports/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("records import routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stages a CSV and returns its immutable preview plan", async () => {
    const bytes = new Uint8Array([115, 117, 98, 106, 101, 99, 116]);
    mocks.stage.mockResolvedValue({
      sourcePath: plan.source.path,
      sourceName: plan.source.name,
      bytes,
    });
    mocks.preview.mockResolvedValue(plan);
    const form = new FormData();
    const file = new File(["subject\nInspect lights\n"], "work-orders.csv", {
      type: "text/csv",
    });
    form.set("file", file);
    form.set("object", "work_order");

    const response = await previewImport(
      new Request("http://localhost/api/a/operations/imports/preview", {
        method: "POST",
        body: form,
      }),
      appContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ plan });
    expect(mocks.stage).toHaveBeenCalledWith({
      orgId: "org-a",
      file: expect.objectContaining({ name: "work-orders.csv", type: "text/csv" }),
    });
    expect(mocks.preview).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      sourcePath: plan.source.path,
      sourceName: plan.source.name,
      bytes,
    });
  });

  it("rebuilds the reviewed plan before starting the governed action", async () => {
    mocks.preview.mockResolvedValue(plan);
    mocks.start.mockResolvedValue({
      status: "executed",
      actionRequestId: "request-1",
      importRunId: "import-1",
      policy: "records_import_start_default",
    });

    const response = await startImport(
      jsonRequest({
        object: "work_order",
        sourcePath: plan.source.path,
        sourceName: plan.source.name,
        mapping: { subject: "subject" },
        duplicateKey: "id",
        batchSize: 100,
      }),
      appContext,
    );

    expect(response.status).toBe(200);
    expect(mocks.preview).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      objectApiName: "work_order",
      sourcePath: plan.source.path,
      sourceName: plan.source.name,
      mapping: { subject: "subject" },
      duplicateKey: "id",
      batchSize: 100,
      emptyTextColumns: undefined,
    });
    expect(mocks.start).toHaveBeenCalledWith({ orgId: "org-a", plan });
  });

  it("returns 202 without inventing a run id while execution is queued", async () => {
    mocks.preview.mockResolvedValue(plan);
    mocks.start.mockResolvedValue({
      status: "queued",
      actionRequestId: "request-2",
      importRunId: null,
      policy: "records_import_start_default",
    });

    const response = await startImport(
      jsonRequest({
        object: "work_order",
        sourcePath: plan.source.path,
        sourceName: plan.source.name,
        mapping: { subject: "subject" },
      }),
      appContext,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "queued",
      actionRequestId: "request-2",
      importRunId: null,
    });
  });

  it("scopes status and cancellation to the current organization and app", async () => {
    mocks.status.mockResolvedValue(run);
    mocks.cancel.mockResolvedValue({
      status: "executed",
      actionRequestId: "request-3",
      importRunId: "import-1",
      policy: "records_import_cancel_default",
    });

    const statusResponse = await getImport(new Request("http://localhost"), runContext);
    const cancelResponse = await cancelImport(new Request("http://localhost"), runContext);

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({ run });
    expect(cancelResponse.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      importRunId: "import-1",
    });
    expect(mocks.cancel).toHaveBeenCalledWith({
      orgId: "org-a",
      appId: "operations",
      importRunId: "import-1",
    });
  });

  it("maps policy and worker failures without claiming success", async () => {
    mocks.preview.mockResolvedValue(plan);
    mocks.start.mockRejectedValueOnce(new RecordImportWebPermissionError("policy denied"));
    const denied = await startImport(
      jsonRequest({
        object: "work_order",
        sourcePath: plan.source.path,
        sourceName: plan.source.name,
        mapping: { subject: "subject" },
      }),
      appContext,
    );
    expect(denied.status).toBe(403);

    mocks.start.mockRejectedValueOnce(
      new RecordImportWebExecutionError("worker rejected import", "request-4"),
    );
    const failed = await startImport(
      jsonRequest({
        object: "work_order",
        sourcePath: plan.source.path,
        sourceName: plan.source.name,
        mapping: { subject: "subject" },
      }),
      appContext,
    );
    expect(failed.status).toBe(422);
    await expect(failed.json()).resolves.toEqual({
      error: "worker rejected import",
      actionRequestId: "request-4",
    });
  });
});
