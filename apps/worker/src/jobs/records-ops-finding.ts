import {
  db,
  workflow_definition,
  workflow_run,
  work_run,
  work_thread,
} from "@neko/db";
import { handleWorkflowOutput } from "@neko/llm/workflows";

export type RecordsOpsFinding = {
  status: "succeeded" | "failed";
  title: string;
  body: string;
  mood: "good" | "watch" | "act";
  payload: Record<string, unknown>;
  scope: string;
  topic: string;
  freshnessTtlSeconds: number;
};

export async function seedOpenNekoOpsWorkflow(orgId: string): Promise<string> {
  const [workflow] = await db()
    .insert(workflow_definition)
    .values({
      org_id: orgId,
      owner_user_id: "",
      name: "OpenNeko operations",
      description: "Built-in substrate health, backup, and storage findings.",
      goal: "Surface operational risks before they become incidents.",
      enabled: true,
      status: "active",
      cron_enabled: false,
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
  if (!workflow) throw new Error("failed to seed OpenNeko operations workflow");
  return workflow.id;
}

async function createOpsRun(orgId: string, finding: RecordsOpsFinding) {
  const workflowId = await seedOpenNekoOpsWorkflow(orgId);
  return db().transaction(async (transaction) => {
    const [thread] = await transaction
      .insert(work_thread)
      .values({
        org_id: orgId,
        title: finding.title,
        channel: "system",
      })
      .returning({ id: work_thread.id });
    if (!thread) throw new Error("failed to create operations finding thread");

    const now = new Date();
    const [workRun] = await transaction
      .insert(work_run)
      .values({
        org_id: orgId,
        thread_id: thread.id,
        backend: "records-ops-watcher",
        status: finding.status === "succeeded" ? "completed" : "failed",
        actor_role: "service",
        error: finding.status === "failed" ? finding.body : null,
        finished_at: now,
      })
      .returning({ id: work_run.id });
    if (!workRun) throw new Error("failed to create operations work run");

    const [workflowRun] = await transaction
      .insert(workflow_run)
      .values({
        org_id: orgId,
        workflow_id: workflowId,
        thread_id: thread.id,
        work_run_id: workRun.id,
        trigger_kind: "schedule",
        trigger_payload: { kind: finding.topic },
        status: finding.status === "succeeded" ? "completed" : "failed",
        started_at: now,
        finished_at: now,
        summary: finding.body,
        error: finding.status === "failed" ? finding.body : null,
      })
      .returning({ id: workflow_run.id });
    if (!workflowRun) throw new Error("failed to create operations workflow run");
    return { workRunId: workRun.id, workflowRunId: workflowRun.id };
  });
}

export async function publishRecordsOpsFinding(
  orgId: string,
  finding: RecordsOpsFinding,
): Promise<void> {
  const run = await createOpsRun(orgId, finding);
  await handleWorkflowOutput(
    {
      orgId,
      workflowRunId: run.workflowRunId,
      workRunId: run.workRunId,
      emit: () => undefined,
    },
    {
      kind: "finding",
      title: finding.title,
      body: finding.body,
      payload: finding.payload,
      scope: finding.scope,
      topic: finding.topic,
      mood: finding.mood,
      freshnessTtlSeconds: finding.freshnessTtlSeconds,
    },
  );
}
