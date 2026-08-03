import { db, workflow_definition } from "@neko/db";
import {
  parseRecordsStarterWatchChoices,
  type RecordImportReport,
} from "@neko/records";
import {
  publishRecordsSystemFinding,
  type RecordsSystemFinding,
} from "./records-system-finding.js";

type JsonRecord = Record<string, unknown>;

export type RecordsImportReport = {
  appId: string;
  status: "succeeded" | "failed";
  runIds: string[];
  progress: Record<string, number>;
  reports: Record<string, unknown>;
  identity?: Record<string, unknown>;
  cleanup?: Record<string, unknown>;
  error?: string;
};

export function buildRecordsSingleImportReport(input: {
  appId: string;
  importRunId: string;
  report: RecordImportReport | null;
  terminalError: Record<string, unknown> | null;
  cleanup?: Record<string, unknown>;
}): RecordsImportReport {
  const succeeded = input.report?.status === "succeeded";
  const cancelled = input.report?.status === "cancelled";
  return {
    appId: input.appId,
    status: succeeded ? "succeeded" : "failed",
    runIds: [input.importRunId],
    progress: {
      total: 1,
      succeeded: succeeded ? 1 : 0,
      failed: input.terminalError ? 1 : 0,
      cancelled: cancelled ? 1 : 0,
    },
    reports: {
      [input.importRunId]:
        input.report ?? input.terminalError ?? { status: "failed" },
    },
    ...(input.cleanup ? { cleanup: input.cleanup } : {}),
    ...(input.terminalError
      ? { error: String(input.terminalError.message) }
      : cancelled
        ? { error: "import was cancelled" }
        : {}),
  };
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonRecord =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];
}

export async function seedRecordsLifecycleWorkflow(orgId: string): Promise<string> {
  const [workflow] = await db()
    .insert(workflow_definition)
    .values({
      org_id: orgId,
      owner_user_id: "",
      name: "Records lifecycle",
      description: "Built-in app creation and import completion summaries.",
      goal: "Make records-engine milestones and import outcomes visible in Briefing.",
      enabled: true,
      status: "active",
      cron_enabled: false,
      system_prompt_overlay:
        "Built-in records lifecycle reporter. Emit only deterministic facts from completed governed operations.",
    })
    .onConflictDoUpdate({
      target: [
        workflow_definition.org_id,
        workflow_definition.owner_user_id,
        workflow_definition.name,
      ],
      set: {
        enabled: true,
        status: "active",
        updated_at: new Date(),
      },
    })
    .returning({ id: workflow_definition.id });
  if (!workflow) throw new Error("failed to seed records lifecycle workflow");
  return workflow.id;
}

async function publishLifecycleFinding(input: {
  orgId: string;
  event: string;
  finding: RecordsSystemFinding;
}): Promise<void> {
  await publishRecordsSystemFinding({
    orgId: input.orgId,
    workflowId: await seedRecordsLifecycleWorkflow(input.orgId),
    backend: "records-lifecycle",
    triggerKind: "external_event",
    triggerPayload: { event: input.event },
    finding: input.finding,
  });
}

export function buildRecordsAppCreationFinding(input: {
  appId: string;
  actionPayload: JsonRecord;
  seededWatchKeys: string[];
}): RecordsSystemFinding {
  const objects = records(input.actionPayload.objects);
  const pages = records(input.actionPayload.pages);
  const selected = parseRecordsStarterWatchChoices(input.actionPayload).filter(
    (choice) => choice.enabled,
  );
  const label =
    typeof input.actionPayload.label === "string" && input.actionPayload.label.trim()
      ? input.actionPayload.label.trim()
      : input.appId;
  return {
    title: `${label} is ready`,
    body: `${label} was created with ${objects.length} object${objects.length === 1 ? "" : "s"}, ${pages.length} page${pages.length === 1 ? "" : "s"}, and ${input.seededWatchKeys.length} enabled starter watch${input.seededWatchKeys.length === 1 ? "" : "es"}.`,
    mood: "good",
    payload: {
      appId: input.appId,
      objectCount: objects.length,
      pageCount: pages.length,
      requestedStarterWatches: selected.map((choice) => choice.key),
      seededStarterWatches: input.seededWatchKeys,
    },
    scope: `records.${input.appId}`,
    topic: "app_created",
    freshnessTtlSeconds: 7 * 24 * 60 * 60,
  };
}

export async function publishRecordsAppCreationSummary(input: {
  orgId: string;
  appId: string;
  actionPayload: JsonRecord;
  seededWatchKeys: string[];
}): Promise<void> {
  await publishLifecycleFinding({
    orgId: input.orgId,
    event: "app_created",
    finding: buildRecordsAppCreationFinding(input),
  });
}

export function buildRecordsImportReportFinding(
  report: RecordsImportReport,
): RecordsSystemFinding {
  const succeeded = report.progress.succeeded ?? 0;
  const total = report.progress.total ?? report.runIds.length;
  const failed = report.progress.failed ?? 0;
  const cancelled = report.progress.cancelled ?? 0;
  const good = report.status === "succeeded";
  return {
    title: good
      ? `${report.appId} import completed`
      : `${report.appId} import needs attention`,
    body: good
      ? `All ${total} import run${total === 1 ? "" : "s"} completed successfully. ${succeeded} succeeded; identity reconciliation and staging cleanup results are attached.`
      : `${succeeded} of ${total} import runs succeeded; ${failed} failed and ${cancelled} were cancelled. Review the attached per-run report before retrying or cutting over.`,
    mood: good ? "good" : "act",
    payload: {
      appId: report.appId,
      status: report.status,
      runIds: report.runIds,
      progress: report.progress,
      reports: report.reports,
      ...(report.identity ? { identity: report.identity } : {}),
      ...(report.cleanup ? { cleanup: report.cleanup } : {}),
      ...(report.error ? { error: report.error } : {}),
    },
    scope: `records.${report.appId}`,
    topic: "import_report",
    freshnessTtlSeconds: 30 * 24 * 60 * 60,
  };
}

export async function publishRecordsImportReport(input: {
  orgId: string;
  report: RecordsImportReport;
}): Promise<void> {
  await publishLifecycleFinding({
    orgId: input.orgId,
    event: "import_completed",
    finding: buildRecordsImportReportFinding(input.report),
  });
}
