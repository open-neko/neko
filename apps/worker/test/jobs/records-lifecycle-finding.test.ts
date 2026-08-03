import { describe, expect, it } from "vitest";
import {
  buildRecordsAppCreationFinding,
  buildRecordsImportReportFinding,
  buildRecordsSingleImportReport,
} from "../../src/jobs/records-lifecycle-finding.js";

describe("records lifecycle findings", () => {
  it("summarizes the governed app shape and only enabled starter watches", () => {
    const finding = buildRecordsAppCreationFinding({
      appId: "crm",
      actionPayload: {
        label: "Sales CRM",
        objects: [{ api_name: "account" }, { api_name: "opportunity" }],
        pages: [{ api_name: "overview" }],
        starter_workflows: [
          { key: "opportunities_without_activity", enabled: true },
          { key: "deals_closing_this_month", enabled: false },
        ],
      },
      seededWatchKeys: ["opportunities_without_activity"],
    });

    expect(finding).toMatchObject({
      title: "Sales CRM is ready",
      mood: "good",
      scope: "records.crm",
      topic: "app_created",
      payload: {
        appId: "crm",
        objectCount: 2,
        pageCount: 1,
        requestedStarterWatches: ["opportunities_without_activity"],
        seededStarterWatches: ["opportunities_without_activity"],
      },
    });
  });

  it("keeps the complete import audit in a successful briefing finding", () => {
    const finding = buildRecordsImportReportFinding({
      appId: "crm",
      status: "succeeded",
      runIds: ["run-1", "run-2"],
      progress: { total: 2, succeeded: 2, failed: 0, cancelled: 0 },
      reports: { "run-1": { inserted: 12 }, "run-2": { inserted: 4 } },
      identity: { status: "reconciled", linked: 3 },
      cleanup: { status: "deleted" },
    });

    expect(finding).toMatchObject({
      title: "crm import completed",
      mood: "good",
      topic: "import_report",
      payload: {
        progress: { total: 2, succeeded: 2 },
        identity: { status: "reconciled", linked: 3 },
        cleanup: { status: "deleted" },
      },
    });
  });

  it("makes a terminal partial import actionable", () => {
    const finding = buildRecordsImportReportFinding({
      appId: "crm",
      status: "failed",
      runIds: ["run-1", "run-2"],
      progress: { total: 2, succeeded: 1, failed: 1, cancelled: 0 },
      reports: { "run-2": { code: "invalid_row" } },
      error: "1 failed and 0 cancelled",
    });

    expect(finding).toMatchObject({
      title: "crm import needs attention",
      mood: "act",
      payload: { status: "failed", error: "1 failed and 0 cancelled" },
    });
  });

  it.each([
    {
      name: "success",
      report: { status: "succeeded", inserted: 3 },
      terminalError: null,
      expected: {
        status: "succeeded",
        progress: { succeeded: 1, failed: 0, cancelled: 0 },
      },
    },
    {
      name: "cancellation",
      report: { status: "cancelled", inserted: 1 },
      terminalError: null,
      expected: {
        status: "failed",
        progress: { succeeded: 0, failed: 0, cancelled: 1 },
        error: "import was cancelled",
      },
    },
    {
      name: "terminal failure",
      report: null,
      terminalError: { code: "invalid_source", message: "source is invalid" },
      expected: {
        status: "failed",
        progress: { succeeded: 0, failed: 1, cancelled: 0 },
        error: "source is invalid",
      },
    },
  ])("maps a single-run $name into the lifecycle report", (input) => {
    expect(
      buildRecordsSingleImportReport({
        appId: "crm",
        importRunId: "run-1",
        report: input.report as never,
        terminalError: input.terminalError,
      }),
    ).toMatchObject({
      appId: "crm",
      runIds: ["run-1"],
      progress: { total: 1 },
      ...input.expected,
    });
  });
});
