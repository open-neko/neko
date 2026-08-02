import { db, workflow_run, work_run, work_thread } from "@neko/db";
import { handleWorkflowOutput } from "@neko/llm/workflows";

export type RecordsSystemFinding = {
  title: string;
  body: string;
  mood: "good" | "watch" | "act";
  payload: Record<string, unknown>;
  scope: string;
  topic: string;
  freshnessTtlSeconds: number;
};

export async function publishRecordsSystemFinding(input: {
  orgId: string;
  workflowId: string;
  backend: string;
  triggerKind: "watcher" | "schedule" | "external_event";
  triggerPayload: Record<string, unknown>;
  finding: RecordsSystemFinding;
}): Promise<void> {
  const run = await db().transaction(async (transaction) => {
    const [thread] = await transaction
      .insert(work_thread)
      .values({
        org_id: input.orgId,
        title: input.finding.title,
        channel: "system",
      })
      .returning({ id: work_thread.id });
    if (!thread) throw new Error("failed to create records finding thread");
    const now = new Date();
    const [workRun] = await transaction
      .insert(work_run)
      .values({
        org_id: input.orgId,
        thread_id: thread.id,
        backend: input.backend,
        status: "completed",
        actor_role: "service",
        finished_at: now,
      })
      .returning({ id: work_run.id });
    if (!workRun) throw new Error("failed to create records finding work run");
    const [workflowRun] = await transaction
      .insert(workflow_run)
      .values({
        org_id: input.orgId,
        workflow_id: input.workflowId,
        thread_id: thread.id,
        work_run_id: workRun.id,
        trigger_kind: input.triggerKind,
        trigger_payload: input.triggerPayload,
        status: "completed",
        started_at: now,
        finished_at: now,
        summary: input.finding.body,
      })
      .returning({ id: workflow_run.id });
    if (!workflowRun) throw new Error("failed to create records finding workflow run");
    return { workRunId: workRun.id, workflowRunId: workflowRun.id };
  });
  await handleWorkflowOutput(
    {
      orgId: input.orgId,
      workflowRunId: run.workflowRunId,
      workRunId: run.workRunId,
      emit: () => undefined,
    },
    {
      kind: "finding",
      title: input.finding.title,
      body: input.finding.body,
      payload: input.finding.payload,
      scope: input.finding.scope,
      topic: input.finding.topic,
      mood: input.finding.mood,
      freshnessTtlSeconds: input.finding.freshnessTtlSeconds,
    },
  );
}
