import type { Pool } from "pg";
import { and, app_state, db, eq, sql } from "@neko/db";
import { enqueue, QUEUE } from "@neko/db/jobs";
import type { ActionRequestRecord } from "@neko/llm/workflows";
import {
  seedRecordSyncCursor,
  type RecordsGraphjinTransport,
  type RecordArtifactImportPlan,
} from "@neko/records";
import { reconcileArtifactIdentities } from "./artifact-identity.js";

type ArtifactImportState = {
  kind: "artifact";
  status: string;
  action_request_id: string;
  source_instance_id: string;
  manifest_hash: string;
  artifact_path: string;
  run_ids: string[];
  started_at: string;
  completed_at?: string;
  progress?: Record<string, number>;
  reports?: Record<string, unknown>;
  error?: string;
  identity?: Record<string, unknown>;
};

function stateFor(
  request: ActionRequestRecord,
  plan: RecordArtifactImportPlan,
  status: string,
  runIds: string[] = [],
): ArtifactImportState {
  return {
    kind: "artifact",
    status,
    action_request_id: request.id,
    source_instance_id: plan.manifest.source.instanceId,
    manifest_hash: plan.manifest.manifestHash,
    artifact_path: plan.directory,
    run_ids: runIds,
    started_at: new Date().toISOString(),
  };
}

function connectorFor(
  request: ActionRequestRecord,
  plan: RecordArtifactImportPlan,
): Record<string, unknown> {
  return {
    kind: plan.manifest.source.kind,
    source_instance_id: plan.manifest.source.instanceId,
    manifest_watermark: plan.manifest.watermark,
    ...(typeof request.payload.export_action_request_id === "string"
      ? { export_action_request_id: request.payload.export_action_request_id }
      : {}),
    objects: plan.manifest.objects.map((object) => ({
      source_api_name: object.sourceApiName,
      object_api_name: object.objectApiName,
      watermark:
        object.watermark ??
        plan.manifest.watermark ??
        { system_modstamp: plan.manifest.generatedAt },
    })),
  };
}

async function upsertState(input: {
  orgId: string;
  appId: string;
  status: "importing" | "degraded";
  mode: string;
  connector: Record<string, unknown>;
  importState: ArtifactImportState;
}): Promise<void> {
  const config = JSON.stringify({
    mode: input.mode,
    connector: input.connector,
    import: input.importState,
  });
  await db().execute(sql`
    insert into ${app_state} (org_id, app_id, status, created_by, config)
    values (${input.orgId}, ${input.appId}, ${input.status}, null, ${config}::jsonb)
    on conflict (org_id, app_id) do update
    set status = excluded.status,
        config = app_state.config || excluded.config
  `);
}

export async function stageArtifactImportState(
  request: ActionRequestRecord,
  plan: RecordArtifactImportPlan,
): Promise<void> {
  await upsertState({
    orgId: request.orgId,
    appId: plan.definition.appId,
    status: "importing",
    mode: plan.manifest.source.mode,
    connector: connectorFor(request, plan),
    importState: stateFor(request, plan, "schema"),
  });
}

export async function trackArtifactImportRuns(
  request: ActionRequestRecord,
  plan: RecordArtifactImportPlan,
  runIds: string[],
): Promise<void> {
  await upsertState({
    orgId: request.orgId,
    appId: plan.definition.appId,
    status: "importing",
    mode: plan.manifest.source.mode,
    connector: connectorFor(request, plan),
    importState: stateFor(request, plan, "running", runIds),
  });
}

export async function failArtifactImportState(
  request: ActionRequestRecord,
  plan: RecordArtifactImportPlan,
  error: unknown,
): Promise<void> {
  const failed = stateFor(request, plan, "failed");
  failed.completed_at = new Date().toISOString();
  failed.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
  await upsertState({
    orgId: request.orgId,
    appId: plan.definition.appId,
    status: "degraded",
    mode: plan.manifest.source.mode,
    connector: connectorFor(request, plan),
    importState: failed,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Refresh the best-effort metadata mirror from authoritative target import runs. */
export async function refreshArtifactImportState(
  pool: Pool,
  input: {
    orgId: string;
    importRunId: string;
    graphjin?: RecordsGraphjinTransport;
    serviceToken?: string;
  },
): Promise<{ matched: boolean; status?: string }> {
  const states = await db()
    .select({ appId: app_state.app_id, config: app_state.config })
    .from(app_state)
    .where(eq(app_state.org_id, input.orgId));
  const match = states.find((row) => {
    const state = asRecord(row.config.import);
    return (
      state?.kind === "artifact" &&
      Array.isArray(state.run_ids) &&
      state.run_ids.includes(input.importRunId)
    );
  });
  if (!match) return { matched: false };
  const state = asRecord(match.config.import)!;
  const runIds = (state.run_ids as unknown[]).filter(
    (id): id is string => typeof id === "string",
  );
  const result = await pool.query<{
    id: string;
    status: string;
    report: Record<string, unknown> | null;
    error: Record<string, unknown> | null;
  }>(
    `select id::text, status, result->'report' as report, error
     from engine.import_run
     where org_id = $1 and id = any($2::uuid[])
     order by id`,
    [input.orgId, runIds],
  );
  const counts = {
    total: runIds.length,
    planned: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const run of result.rows) {
    if (run.status in counts && run.status !== "total") {
      counts[run.status as keyof Omit<typeof counts, "total">] += 1;
    }
  }
  const missing = runIds.length - result.rows.length;
  const complete = counts.succeeded === runIds.length && missing === 0;
  const terminal =
    counts.succeeded + counts.failed + counts.cancelled === runIds.length && missing === 0;
  const status = complete ? "succeeded" : terminal || missing > 0 ? "failed" : "running";
  const next: ArtifactImportState = {
    ...(state as ArtifactImportState),
    status,
    progress: { ...counts, missing },
    ...(status === "running" ? {} : { completed_at: new Date().toISOString() }),
    ...(status === "failed"
      ? {
          error:
            missing > 0
              ? `${missing} target import runs are missing`
              : `${counts.failed} failed and ${counts.cancelled} cancelled`,
        }
      : {}),
    reports: Object.fromEntries(
      result.rows.map((run) => [run.id, run.report ?? run.error ?? { status: run.status }]),
    ),
  };
  if (complete) {
    const connector = asRecord(match.config.connector);
    const sourceInstanceId = connector?.source_instance_id;
    const objects = connector?.objects;
    const manifestHash = state.manifest_hash;
    const importActionRequestId = state.action_request_id;
    if (
      typeof sourceInstanceId !== "string" ||
      !Array.isArray(objects) ||
      typeof manifestHash !== "string" ||
      typeof importActionRequestId !== "string"
    ) {
      throw new Error("completed artifact import is missing connector cursor metadata");
    }
    for (const value of objects) {
      const object = asRecord(value);
      const objectApiName = object?.object_api_name;
      const watermark = asRecord(object?.watermark);
      if (typeof objectApiName !== "string" || !watermark) {
        throw new Error("completed artifact import has invalid object cursor metadata");
      }
      await seedRecordSyncCursor(pool, {
        orgId: input.orgId,
        appId: match.appId,
        sourceInstanceId,
        objectApiName,
        watermark,
        manifestHash,
      });
    }
    const hasSourceUsers = objects.some(
      (value) =>
        asRecord(value)?.source_api_name?.toString().toLocaleLowerCase("en-US") ===
        "user",
    );
    if (hasSourceUsers) {
      if (!input.graphjin || !input.serviceToken) {
        throw new Error("completed identity import requires the records GraphJin service");
      }
      const identity = await reconcileArtifactIdentities(pool, {
        orgId: input.orgId,
        appId: match.appId,
        sourceInstanceId,
        manifestHash,
        importActionRequestId,
        graphjin: input.graphjin,
        serviceToken: input.serviceToken,
      });
      next.identity = identity.report;
      if (identity.action?.status === "approved") {
        await enqueue(
          QUEUE.ACTION_EXECUTE,
          { orgId: input.orgId, actionRequestId: identity.action.id },
          { singletonKey: `records-identity-import:${identity.action.id}` },
        );
      }
    } else {
      next.identity = { status: "not_available" };
    }
  }
  await db()
    .update(app_state)
    .set({
      status: complete ? "active" : status === "failed" ? "degraded" : "importing",
      config: sql`${app_state.config} || ${JSON.stringify({ import: next })}::jsonb`,
    })
    .where(and(eq(app_state.org_id, input.orgId), eq(app_state.app_id, match.appId)));
  return { matched: true, status };
}
