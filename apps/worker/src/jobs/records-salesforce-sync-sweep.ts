import {
  and,
  app_state,
  db,
  eq,
  inArray,
  processing_job,
  sql,
} from "@neko/db";
import type { RecordsSalesforceSyncPayload } from "@neko/db/jobs";
import {
  getSalesforceSyncState,
  updateSalesforceSyncState,
  type SalesforceSyncState,
} from "../records/salesforce-sync-state.js";

export type SalesforceSyncSweepDependencies = {
  candidates: () => Promise<Array<{ orgId: string; appId: string }>>;
  getState: typeof getSalesforceSyncState;
  createOrResumeJob: (state: SalesforceSyncState) => Promise<string | null>;
  enqueue: (payload: RecordsSalesforceSyncPayload) => Promise<string | null>;
  markEnqueued: (state: SalesforceSyncState, at: string) => Promise<void>;
  now: () => Date;
};

export const defaultSalesforceSyncSweepDependencies: SalesforceSyncSweepDependencies = {
  candidates: async () =>
    db()
      .select({ orgId: app_state.org_id, appId: app_state.app_id })
      .from(app_state)
      .where(eq(app_state.status, "active")),
  getState: getSalesforceSyncState,
  createOrResumeJob: async (state) =>
    db().transaction(async (transaction) => {
      const identity = `${state.orgId}:${state.appId}:${state.sourceInstanceId}:sync-schedule`;
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
      );
      const existing = await transaction
        .select({ id: processing_job.id })
        .from(processing_job)
        .where(
          and(
            eq(processing_job.org_id, state.orgId),
            eq(processing_job.kind, "records_salesforce_sync"),
            inArray(processing_job.status, ["queued", "running", "retrying"]),
            sql`${processing_job.trigger_payload}->>'app_id' = ${state.appId}`,
            sql`${processing_job.trigger_payload}->>'source_instance_id' = ${state.sourceInstanceId}`,
          ),
        )
        .orderBy(sql`${processing_job.created_at} desc`)
        .limit(1);
      if (existing[0]) return existing[0].id;
      const [created] = await transaction
        .insert(processing_job)
        .values({
          org_id: state.orgId,
          kind: "records_salesforce_sync",
          status: "queued",
          trigger: "schedule",
          trigger_payload: {
            app_id: state.appId,
            source_instance_id: state.sourceInstanceId,
          },
          progress: { stage: "queued" },
        })
        .returning({ id: processing_job.id });
      return created?.id ?? null;
    }),
  enqueue: async () => {
    throw new Error("Salesforce sync sweep queue is not configured");
  },
  markEnqueued: async (state, at) =>
    updateSalesforceSyncState(state, {
      status: "queued",
      lastEnqueuedAt: at,
      lastError: null,
    }),
  now: () => new Date(),
};

export async function runRecordsSalesforceSyncSweep(
  dependencies: SalesforceSyncSweepDependencies =
    defaultSalesforceSyncSweepDependencies,
): Promise<{ inspected: number; queued: number; skipped: number }> {
  const candidates = await dependencies.candidates();
  let queued = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    let state: SalesforceSyncState | null;
    try {
      state = await dependencies.getState(candidate.orgId, candidate.appId);
    } catch {
      skipped += 1;
      continue;
    }
    if (!state || !state.enabled || state.mode === "primary") {
      skipped += 1;
      continue;
    }
    const now = dependencies.now();
    const dueAt =
      (state.lastEnqueuedAt ? Date.parse(state.lastEnqueuedAt) : 0) +
      state.intervalMinutes * 60_000;
    if (now.getTime() < dueAt && state.status !== "queued" && state.status !== "retrying") {
      skipped += 1;
      continue;
    }
    const processingJobId = await dependencies.createOrResumeJob(state);
    if (!processingJobId) {
      skipped += 1;
      continue;
    }
    await dependencies.enqueue({
      processingJobId,
      orgId: state.orgId,
      appId: state.appId,
      sourceInstanceId: state.sourceInstanceId,
    });
    await dependencies.markEnqueued(state, now.toISOString());
    queued += 1;
  }
  return { inspected: candidates.length, queued, skipped };
}
