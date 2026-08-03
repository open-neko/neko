import type {
  ActionRequestRecord,
  CreateActionRequestInput,
} from "@neko/llm/workflows";
import { describe, expect, it, vi } from "vitest";
import {
  RecordsCliImportError,
  createRecordsCliImportBridge,
} from "../../src/records/cli-import.js";

const at = new Date("2026-08-03T06:00:00.000Z");

function request(
  input: CreateActionRequestInput,
  payload: Record<string, unknown> = input.payload ?? {},
): ActionRequestRecord {
  return {
    id: "request-cli-import",
    orgId: input.orgId,
    actorUserId: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    actorBackend: input.actorBackend ?? null,
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: input.scope,
    kind: input.kind,
    target: input.target ?? null,
    payload,
    riskLevel: input.riskLevel ?? null,
    status: input.status,
    summary: input.summary ?? null,
    intent: input.intent ?? null,
    minutesSaved: null,
    minutesSavedBasis: null,
    workRunId: null,
    requestedByRunId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectionReason: null,
    createdAt: at,
    updatedAt: at,
  };
}

function dependencies(input: { appMatches?: string[] } = {}) {
  const appMatches = input.appMatches ?? ["equipment"];
  const createRequest = vi.fn(async (value: CreateActionRequestInput) =>
    request(value, {
      ...value.payload,
      import_plan: { planHash: "planned" },
    }),
  );
  const current = request({
    orgId: "org-a",
    scope: "internal",
    kind: "records_import_start",
    target: "record-import:equipment/loan",
    status: "pending_approval",
    actorRole: "admin",
    actorBackend: "openneko-cli",
  });
  const getRequest = vi.fn(async () => current);
  const approveRequest = vi.fn(async () => ({
    ...current,
    status: "approved" as const,
  }));
  const enqueueAction = vi.fn().mockResolvedValue("job-1");
  const registry = {
    listApps: vi.fn(async () =>
      appMatches.map((appId) => ({ appId })),
    ),
    loadApp: vi.fn(async (_orgId: string, appId: string) => ({
      objects: [
        {
          apiName: "loan",
          archivedAt: appMatches.includes(appId) ? null : at,
        },
      ],
    })),
  };
  return {
    input: {
      orgId: "org-a",
      workspaceForOrg: vi
        .fn()
        .mockResolvedValue({ orgRoot: "/tmp/openneko-home/org-a" }),
      registry: registry as never,
      createRequest,
      getRequest,
      approveRequest,
      enqueueAction,
    },
    createRequest,
    approveRequest,
    enqueueAction,
  };
}

describe("records CLI import bridge", () => {
  it("prepares the normal CSV action and resolves an unambiguous object app", async () => {
    const deps = dependencies();
    const bridge = createRecordsCliImportBridge(deps.input);
    await expect(
      bridge.prepare({
        mode: "file",
        sourcePath: "imports/cli/stage-1/loans.csv",
        object: "loan",
        mapping: { ID: "id", Borrower: "borrower" },
        duplicateKey: "id",
        batchSize: 75,
      }),
    ).resolves.toMatchObject({
      request: {
        id: "request-cli-import",
        kind: "records_import_start",
        status: "pending_approval",
        payload: { import_plan: { planHash: "planned" } },
      },
    });
    expect(deps.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRole: "admin",
        actorBackend: "openneko-cli",
        kind: "records_import_start",
        target: "record-import:equipment/loan",
        payload: {
          app: "equipment",
          object: "loan",
          source_path: "imports/cli/stage-1/loans.csv",
          mapping: { ID: "id", Borrower: "borrower" },
          duplicate_key: "id",
          batch_size: 75,
        },
      }),
    );
  });

  it("prepares an artifact action without bypassing schema preflight", async () => {
    const deps = dependencies();
    const bridge = createRecordsCliImportBridge(deps.input);
    await bridge.prepare({
      mode: "artifact",
      sourcePath: "imports/cli/stage-2/sf-export",
      app: "crm",
      label: "Sales CRM",
      purpose: "Replace Salesforce",
    });
    expect(deps.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "records_artifact_import_start",
        target: "record-import:crm",
        status: "pending_approval",
        payload: {
          artifact_path: "imports/cli/stage-2/sf-export",
          app: "crm",
          label: "Sales CRM",
          purpose: "Replace Salesforce",
        },
      }),
    );
  });

  it("requires --app when an object exists in multiple apps", async () => {
    const deps = dependencies({ appMatches: ["equipment", "operations"] });
    const bridge = createRecordsCliImportBridge(deps.input);
    await expect(
      bridge.prepare({
        mode: "file",
        sourcePath: "imports/cli/stage-1/loans.csv",
        object: "loan",
      }),
    ).rejects.toThrow(/multiple apps/);
    expect(deps.createRequest).not.toHaveBeenCalled();
  });

  it("rejects invalid API identifiers at the bridge boundary", async () => {
    const deps = dependencies();
    const bridge = createRecordsCliImportBridge(deps.input);
    await expect(
      bridge.prepare({
        mode: "file",
        sourcePath: "imports/cli/stage-1/loans.csv",
        app: "CRM; drop schema public",
        object: "loan",
      }),
    ).rejects.toBeInstanceOf(RecordsCliImportError);
    expect(deps.createRequest).not.toHaveBeenCalled();
  });

  it("approves only CLI-owned imports and enqueues normal action execution", async () => {
    const deps = dependencies();
    const bridge = createRecordsCliImportBridge(deps.input);
    await expect(bridge.start("request-cli-import")).resolves.toEqual({
      requestId: "request-cli-import",
      status: "queued",
      jobId: "job-1",
    });
    expect(deps.approveRequest).toHaveBeenCalledWith({
      id: "request-cli-import",
      orgId: "org-a",
      approverUserId: null,
      approver: { userId: null, role: "admin" },
    });
    expect(deps.enqueueAction).toHaveBeenCalledWith({
      orgId: "org-a",
      actionRequestId: "request-cli-import",
    });

    deps.input.getRequest = vi.fn(async () => ({
      ...(await deps.input.createRequest({
        orgId: "org-a",
        scope: "internal",
        kind: "records_import_start",
        status: "pending_approval",
      })),
      actorBackend: "codex",
    }));
    await expect(
      createRecordsCliImportBridge(deps.input).start("not-cli"),
    ).rejects.toBeInstanceOf(RecordsCliImportError);
  });
});
