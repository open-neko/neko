import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureHostConfigProvisioned: vi.fn(async () => undefined),
  claim: vi.fn(async () => true),
  complete: vi.fn(async () => undefined),
  link: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  prepare: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@neko/llm", () => ({
  ensureHostConfigProvisioned: mocks.ensureHostConfigProvisioned,
  registerAgentCanceller: vi.fn(() => () => undefined),
}));

vi.mock("@neko/llm/work", () => ({
  appendWorkRunEvent: vi.fn(async () => undefined),
  ensureAgentBroker: vi.fn(async () => ({})),
  registerAgentBrokerEventSink: vi.fn(() => () => undefined),
  scrubAgentEvent: vi.fn((_scrubber, event) => event),
  workflowRuntimeDepsFromEnv: vi.fn(() => ({})),
}));

vi.mock("@neko/llm/workflows", () => ({
  claimWorkflowScheduleFiring: mocks.claim,
  completeWorkflowScheduleFiring: mocks.complete,
  linkWorkflowScheduleFiringRun: mocks.link,
  prepareWorkflowRun: mocks.prepare,
  releaseWorkflowScheduleFiringRun: mocks.release,
  runWorkflowTurn: mocks.run,
}));

vi.mock("../../src/plugins/registry-instance.js", () => ({
  getCurrentScrubber: vi.fn(() => ({})),
  getPluginRegistryInstance: vi.fn(() => null),
}));

vi.mock("../../src/records/adapters.js", () => ({
  includeRecordActionDescriptors: vi.fn(() => []),
}));

import {
  runWorkflowRunFire,
  WorkflowRunInterrupted,
} from "../../src/jobs/workflow-run-fire";

const payload = {
  orgId: "org-test",
  workflowId: "f3ffcb96-d81e-422f-b81f-fbe08996287f",
  triggerKind: "cron" as const,
  scheduleFiringId: "5bc05029-f1ac-451d-b063-9736ec64ab93",
  triggerPayload: { firingTime: "2026-08-26T07:00:00.000Z" },
};

const prepared = {
  workflow: { id: payload.workflowId },
  workflowRun: { id: "workflow-run-1" },
  threadId: "thread-1",
  workRunId: "work-run-1",
};

describe("workflow schedule firing consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claim.mockResolvedValue(true);
    mocks.prepare.mockResolvedValue(prepared);
    mocks.run.mockResolvedValue({ status: "completed" });
  });

  it("ignores duplicate deliveries before creating a workflow run", async () => {
    mocks.claim.mockResolvedValue(false);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runWorkflowRunFire(payload);

    expect(mocks.ensureHostConfigProvisioned).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("links and completes the durable firing around one workflow run", async () => {
    await runWorkflowRunFire(payload);

    expect(mocks.claim).toHaveBeenCalledWith({
      firingId: payload.scheduleFiringId,
      orgId: payload.orgId,
      workflowId: payload.workflowId,
    });
    expect(mocks.link).toHaveBeenCalledWith(
      payload.scheduleFiringId,
      prepared.workflowRun.id,
    );
    expect(mocks.complete).toHaveBeenCalledWith(payload.scheduleFiringId);
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it("releases an interrupted firing for at-least-once retry", async () => {
    mocks.run.mockResolvedValue({ status: "cancelled" });

    await expect(runWorkflowRunFire(payload)).rejects.toBeInstanceOf(
      WorkflowRunInterrupted,
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(
      payload.scheduleFiringId,
      expect.any(WorkflowRunInterrupted),
    );
  });

  it("leaves a terminal linked run for recovery if ledger completion fails", async () => {
    mocks.complete.mockRejectedValueOnce(
      new Error("database connection reset"),
    );

    await expect(runWorkflowRunFire(payload)).rejects.toThrow(
      "database connection reset",
    );
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
