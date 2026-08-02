import { describe, expect, it, vi } from "vitest";
import {
  RetryableActionAdapterError,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  RECORD_SALESFORCE_ACTION_DESCRIPTORS,
  RECORD_SALESFORCE_ACTION_KINDS,
  RecordSalesforceActionPayloadError,
  createRecordSalesforceActionAdapter,
  registerRecordSalesforceActions,
  type RecordSalesforceActionDependencies,
  type SalesforceExportJobSummary,
} from "../../src/records/salesforce-adapters.js";

const ACTION_ID = "00000000-0000-4000-a000-000000000701";
const EXPORT_ID = "00000000-0000-4000-a000-000000000702";

function connectorPayload(): Record<string, unknown> {
  return {
    source_instance_id: "salesforce-production",
    instance_url: "https://example.my.salesforce.com",
    client_id: "connected-app",
    client_secret_ref: "salesforce-production-secret",
    app: "crm",
    label: "CRM",
    mode: "mirror",
    objects: ["Account", "Contact"],
  };
}

function request(
  kind: string,
  payload: Record<string, unknown>,
  role = "admin",
): ActionRequestRecord {
  const now = new Date("2026-08-02T12:00:00.000Z");
  return {
    id: ACTION_ID,
    orgId: "org-a",
    actorUserId: "admin-1",
    actorRole: role,
    actorBackend: "codex",
    workflowRunId: null,
    triggeredByObservationId: null,
    policyId: null,
    scope: kind.endsWith("status") ? "internal" : "external",
    kind,
    target: null,
    payload,
    riskLevel: "high",
    status: "approved",
    summary: "Salesforce connector operation",
    intent: "Connect Salesforce",
    minutesSaved: null,
    minutesSavedBasis: null,
    workRunId: null,
    requestedByRunId: null,
    approvedByUserId: "admin-1",
    approvedAt: now,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

function job(status = "queued"): SalesforceExportJobSummary {
  return {
    id: EXPORT_ID,
    status,
    progress: { stage: status },
    result: null,
    error: null,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
  };
}

function dependencies(
  overrides: Partial<RecordSalesforceActionDependencies> = {},
): RecordSalesforceActionDependencies {
  return {
    connectorForAction: vi.fn().mockResolvedValue({
      discover: vi.fn().mockResolvedValue({
        connector: "salesforce",
        sourceInstanceId: "salesforce-production",
        mode: "mirror",
        objects: [],
        warnings: [],
      }),
    }),
    createExport: vi.fn().mockResolvedValue(job()),
    getExport: vi.fn().mockResolvedValue(job("running")),
    cancelExport: vi.fn().mockResolvedValue(job("cancel_requested")),
    enqueueExport: vi.fn().mockResolvedValue("boss-job-1"),
    ...overrides,
  };
}

describe("Salesforce worker action adapters", () => {
  it("publishes governed discovery, launch, status, and cancellation actions", () => {
    expect(RECORD_SALESFORCE_ACTION_DESCRIPTORS.map(({ kind }) => kind)).toEqual(
      RECORD_SALESFORCE_ACTION_KINDS,
    );
    expect(RECORD_SALESFORCE_ACTION_DESCRIPTORS.map(({ default_mode }) => default_mode)).toEqual([
      "ask",
      "ask",
      { internal: "auto" },
      "ask",
    ]);
    expect(RECORD_SALESFORCE_ACTION_DESCRIPTORS[0]?.example).not.toHaveProperty(
      "client_secret",
    );
  });

  it("discovers inventory through the worker-owned connector", async () => {
    const deps = dependencies();
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_discover", deps)({
        request: request("records_salesforce_discover", connectorPayload()),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "records_salesforce_discover",
      externalRef: "salesforce-production",
      result: { connector: "salesforce", mode: "mirror" },
    });
    expect(deps.connectorForAction).toHaveBeenCalledOnce();
  });

  it("creates one durable export and queues its processing-job identity", async () => {
    const deps = dependencies();
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_export_start", deps)({
        request: request("records_salesforce_export_start", connectorPayload()),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "records_salesforce_export_start",
      externalRef: EXPORT_ID,
      result: { id: EXPORT_ID, queueId: "boss-job-1" },
    });
    expect(deps.enqueueExport).toHaveBeenCalledWith({
      processingJobId: EXPORT_ID,
      orgId: "org-a",
      actionRequestId: ACTION_ID,
      exportJobId: EXPORT_ID,
    });
  });

  it("scopes status and cancellation to the request organization", async () => {
    const deps = dependencies();
    await createRecordSalesforceActionAdapter("records_salesforce_export_status", deps)({
      request: request("records_salesforce_export_status", { export_job_id: EXPORT_ID }),
    });
    await createRecordSalesforceActionAdapter("records_salesforce_export_cancel", deps)({
      request: request("records_salesforce_export_cancel", { export_job_id: EXPORT_ID }),
    });
    expect(deps.getExport).toHaveBeenCalledWith("org-a", EXPORT_ID);
    expect(deps.cancelExport).toHaveBeenCalledWith("org-a", EXPORT_ID);
  });

  it("rejects raw secrets, unknown fields, invalid ids, and non-admin actors", async () => {
    const deps = dependencies();
    const discover = createRecordSalesforceActionAdapter(
      "records_salesforce_discover",
      deps,
    );
    await expect(
      discover({
        request: request("records_salesforce_discover", {
          ...connectorPayload(),
          client_secret: "must-never-enter-the-action",
        }),
      }),
    ).rejects.toBeInstanceOf(RecordSalesforceActionPayloadError);
    await expect(
      discover({ request: request("records_salesforce_discover", connectorPayload(), "member") }),
    ).rejects.toBeInstanceOf(RecordSalesforceActionPayloadError);
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_export_status", deps)({
        request: request("records_salesforce_export_status", { export_job_id: "not-a-uuid" }),
      }),
    ).rejects.toBeInstanceOf(RecordSalesforceActionPayloadError);
  });

  it("maps transient Salesforce failures and queue failures to retryable actions", async () => {
    const discoverDeps = dependencies({
      connectorForAction: vi.fn().mockResolvedValue({
        discover: vi.fn().mockRejectedValue(Object.assign(new Error("busy"), { status: 503 })),
      }),
    });
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_discover", discoverDeps)({
        request: request("records_salesforce_discover", connectorPayload()),
      }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);

    const exportDeps = dependencies({
      enqueueExport: vi.fn().mockRejectedValue(new Error("queue unavailable")),
    });
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_export_start", exportDeps)({
        request: request("records_salesforce_export_start", connectorPayload()),
      }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
  });

  it("treats an existing pg-boss singleton as an idempotent launch", async () => {
    const deps = dependencies({ enqueueExport: vi.fn().mockResolvedValue(null) });
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_export_start", deps)({
        request: request("records_salesforce_export_start", connectorPayload()),
      }),
    ).resolves.toMatchObject({
      result: { id: EXPORT_ID, queueId: null, deduplicated: true },
    });
  });

  it("registers every Salesforce action kind", () => {
    const registered: string[] = [];
    registerRecordSalesforceActions({
      enqueueExport: vi.fn(),
      dependencies: dependencies(),
      register: (kind) => registered.push(kind),
    });
    expect(registered).toEqual(RECORD_SALESFORCE_ACTION_KINDS);
  });
});
