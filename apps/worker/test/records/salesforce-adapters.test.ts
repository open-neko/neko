import { describe, expect, it, vi } from "vitest";
import {
  RetryableActionAdapterError,
  type ActionRequestRecord,
} from "@neko/llm/workflows";
import {
  buildSalesforceAppSchema,
  createSalesforceSchemaReview,
} from "@neko/records";
import {
  RECORD_SALESFORCE_ACTION_DESCRIPTORS,
  RECORD_SALESFORCE_ACTION_KINDS,
  RecordSalesforceActionPayloadError,
  createRecordSalesforceActionAdapter,
  createRecordSalesforceExportPreflightHook,
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

function schemaReview() {
  const describes = ["Account", "Contact"].map((name) => ({
    name,
    label: name,
    labelPlural: `${name}s`,
    fields: [
      { name: "Id", label: `${name} ID`, type: "id" },
      {
        name: "Name",
        label: `${name} name`,
        type: "string",
        nameField: true,
        createable: true,
        updateable: true,
      },
    ],
  }));
  return createSalesforceSchemaReview({
    sourceInstanceId: "salesforce-production",
    mode: "mirror",
    plan: buildSalesforceAppSchema({
      app: "crm",
      label: "CRM",
      mode: "mirror",
      describes,
    }),
  });
}

function preparedConnectorPayload(): Record<string, unknown> {
  return {
    ...connectorPayload(),
    salesforce_inventory: {
      connector: "salesforce",
      sourceInstanceId: "salesforce-production",
      mode: "mirror",
      objects: [],
      warnings: [],
    },
    salesforce_schema_review: schemaReview(),
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

function syncState() {
  return {
    orgId: "org-a",
    appId: "crm",
    appStatus: "active",
    mode: "mirror" as const,
    sourceInstanceId: "salesforce-production",
    exportActionRequestId: ACTION_ID,
    objects: [
      {
        sourceApiName: "Account",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
      },
    ],
    enabled: true,
    intervalMinutes: 15,
    status: "queued",
    lastEnqueuedAt: "2026-08-02T12:00:00.000Z",
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    apiBudget: null,
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
      schemaReview: vi.fn().mockResolvedValue(schemaReview()),
    }),
    createExport: vi.fn().mockResolvedValue(job()),
    getExport: vi.fn().mockResolvedValue(job("running")),
    cancelExport: vi.fn().mockResolvedValue(job("cancel_requested")),
    enqueueExport: vi.fn().mockResolvedValue("boss-job-1"),
    enableSync: vi.fn().mockResolvedValue(syncState()),
    createSync: vi.fn().mockResolvedValue(job()),
    enqueueSync: vi.fn().mockResolvedValue("boss-sync-1"),
    ...overrides,
  };
}

describe("Salesforce worker action adapters", () => {
  it("publishes governed discovery, launch, status, and cancellation actions", () => {
    expect(RECORD_SALESFORCE_ACTION_DESCRIPTORS.map(({ kind }) => kind)).toEqual(
      RECORD_SALESFORCE_ACTION_KINDS,
    );
    expect(RECORD_SALESFORCE_ACTION_DESCRIPTORS.map(({ default_mode }) => default_mode)).toEqual([
      "auto",
      "ask",
      { internal: "auto" },
      "ask",
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
        request: request("records_salesforce_export_start", preparedConnectorPayload()),
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
        schemaReview: vi.fn(),
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
        request: request("records_salesforce_export_start", preparedConnectorPayload()),
      }),
    ).rejects.toBeInstanceOf(RetryableActionAdapterError);
  });

  it("treats an existing pg-boss singleton as an idempotent launch", async () => {
    const deps = dependencies({ enqueueExport: vi.fn().mockResolvedValue(null) });
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_export_start", deps)({
        request: request("records_salesforce_export_start", preparedConnectorPayload()),
      }),
    ).resolves.toMatchObject({
      result: { id: EXPORT_ID, queueId: null, deduplicated: true },
    });
  });

  it("enables a reviewed schedule and queues the first delta run", async () => {
    const deps = dependencies();
    await expect(
      createRecordSalesforceActionAdapter("records_salesforce_sync_delta", deps)({
        request: request("records_salesforce_sync_delta", {
          app: "crm",
          interval_minutes: 15,
        }),
      }),
    ).resolves.toMatchObject({
      commandOrOperation: "records_salesforce_sync_delta",
      externalRef: EXPORT_ID,
      result: {
        appId: "crm",
        sourceInstanceId: "salesforce-production",
        intervalMinutes: 15,
        queueId: "boss-sync-1",
      },
    });
    expect(deps.enqueueSync).toHaveBeenCalledWith({
      processingJobId: EXPORT_ID,
      orgId: "org-a",
      appId: "crm",
      sourceInstanceId: "salesforce-production",
    });
  });

  it("preflights a complete credential-free migration plan before approval", async () => {
    const deps = dependencies();
    const updatePayload = vi.fn(async (input: {
      payload: Record<string, unknown>;
    }) => request("records_salesforce_export_start", input.payload));
    const hook = createRecordSalesforceExportPreflightHook({
      connectorForAction: deps.connectorForAction,
      updatePayload: updatePayload as never,
    });
    const prepared = await hook(
      request("records_salesforce_export_start", connectorPayload()),
    );
    expect(prepared?.payload).toMatchObject({
      salesforce_inventory: { connector: "salesforce" },
      salesforce_schema_review: {
        format: "openneko.records.salesforce-schema-review.v1",
        planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        plan: { definition: { appId: "crm" }, mappings: expect.any(Array) },
      },
    });
    expect(JSON.stringify(prepared?.payload)).not.toContain('"client_secret"');
  });

  it("registers every Salesforce action kind and one removable preflight", () => {
    const registered: string[] = [];
    const hook = vi.fn();
    const unregister = vi.fn();
    registerRecordSalesforceActions({
      enqueueExport: vi.fn(),
      enqueueSync: vi.fn(),
      dependencies: dependencies(),
      register: (kind) => registered.push(kind),
      registerPreflight: (candidate) => {
        hook(candidate);
        return unregister;
      },
    });
    expect(registered).toEqual(RECORD_SALESFORCE_ACTION_KINDS);
    expect(hook).toHaveBeenCalledOnce();
  });
});
