import {
  and,
  db,
  eq,
  inArray,
  records_ops_health,
} from "@neko/db";
import type { Pool } from "pg";
import {
  createRecordsStorageMonitor,
  recordsStorageLevels,
  type RecordsStorageLevel,
  type RecordsStorageSample,
} from "../records/storage-health.js";
import { publishRecordsOpsFinding } from "./records-ops-finding.js";
import {
  recordsBackupHealthLevel,
  recordsHealthAge,
  requestRecordsBackupHealth,
  sampleRecordsJobHealth,
  type RecordsBackupHealthSample,
  type RecordsJobHealthSample,
} from "./records-ops-health.js";

const VOLUMES = ["metadata", "records", "staging"] as const;

type Volume = (typeof VOLUMES)[number];
type PersistedLevel = RecordsStorageLevel | "unavailable";

export type RecordsOpsWatchDependencies = {
  sample: () => Promise<RecordsStorageSample>;
  sampleBackup: () => Promise<RecordsBackupHealthSample>;
  sampleJobs?: (orgId: string) => Promise<RecordsJobHealthSample>;
  previous: (orgId: string) => Promise<Partial<Record<Volume, PersistedLevel>>>;
  persist: (
    orgId: string,
    sample: RecordsStorageSample | null,
    levels: Record<Volume, PersistedLevel>,
  ) => Promise<void>;
  previousCheck: (orgId: string, checkName: string) => Promise<PersistedLevel | null>;
  persistCheck: (
    orgId: string,
    checkName: string,
    level: PersistedLevel,
    sample: Record<string, unknown>,
    sampledAt: Date,
  ) => Promise<void>;
  publish: typeof publishRecordsOpsFinding;
  now: () => Date;
};

async function previousCheck(
  orgId: string,
  checkName: string,
): Promise<PersistedLevel | null> {
  const [row] = await db()
    .select({ level: records_ops_health.level })
    .from(records_ops_health)
    .where(
      and(
        eq(records_ops_health.org_id, orgId),
        eq(records_ops_health.check_name, checkName),
      ),
    )
    .limit(1);
  return (row?.level as PersistedLevel | undefined) ?? null;
}

async function persistCheck(
  orgId: string,
  checkName: string,
  level: PersistedLevel,
  sample: Record<string, unknown>,
  sampledAt: Date,
): Promise<void> {
  await db()
    .insert(records_ops_health)
    .values({
      org_id: orgId,
      check_name: checkName,
      level,
      sample,
      sampled_at: sampledAt,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: [records_ops_health.org_id, records_ops_health.check_name],
      set: { level, sample, sampled_at: sampledAt, updated_at: new Date() },
    });
}

export const defaultRecordsOpsWatchDependencies: RecordsOpsWatchDependencies = {
  sample: () => createRecordsStorageMonitor().sample(),
  sampleBackup: requestRecordsBackupHealth,
  previous: async (orgId) => {
    const checks = VOLUMES.map((volume) => `storage:${volume}`);
    const rows = await db()
      .select({ checkName: records_ops_health.check_name, level: records_ops_health.level })
      .from(records_ops_health)
      .where(
        and(
          eq(records_ops_health.org_id, orgId),
          inArray(records_ops_health.check_name, checks),
        ),
      );
    const result: Partial<Record<Volume, PersistedLevel>> = {};
    for (const row of rows) {
      const volume = row.checkName.replace(/^storage:/, "") as Volume;
      if (VOLUMES.includes(volume)) result[volume] = row.level as PersistedLevel;
    }
    return result;
  },
  persist: async (orgId, sample, levels) => {
    const sampledAt = sample ? new Date(sample.sampledAt) : new Date();
    await db().transaction(async (transaction) => {
      for (const volume of VOLUMES) {
        const value = sample?.[volume] ?? {};
        await transaction
          .insert(records_ops_health)
          .values({
            org_id: orgId,
            check_name: `storage:${volume}`,
            level: levels[volume],
            sample: value,
            sampled_at: sampledAt,
            updated_at: new Date(),
          })
          .onConflictDoUpdate({
            target: [records_ops_health.org_id, records_ops_health.check_name],
            set: {
              level: levels[volume],
              sample: value,
              sampled_at: sampledAt,
              updated_at: new Date(),
            },
          });
      }
    });
  },
  previousCheck,
  persistCheck,
  publish: publishRecordsOpsFinding,
  now: () => new Date(),
};

export function createRecordsOpsWatchDependencies(
  recordsPool: Pool,
): RecordsOpsWatchDependencies {
  return {
    ...defaultRecordsOpsWatchDependencies,
    sampleJobs: (orgId) => sampleRecordsJobHealth(recordsPool, orgId),
  };
}

function levelLabel(level: PersistedLevel): string {
  return level.replace("_", " ");
}

function duration(value: number): string {
  if (!Number.isFinite(value)) return "unavailable";
  const hours = value / (60 * 60 * 1_000);
  return hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`;
}

function shouldPublishTransition(
  previous: PersistedLevel | null,
  next: PersistedLevel,
): boolean {
  return previous !== next && !(previous === null && next === "ok");
}

async function watchBackupHealth(
  orgId: string,
  dependencies: RecordsOpsWatchDependencies,
): Promise<{ level: PersistedLevel; findings: number }> {
  const checkName = "backup:whole_deployment";
  const previous = await dependencies.previousCheck(orgId, checkName);
  let sample: RecordsBackupHealthSample;
  try {
    sample = await dependencies.sampleBackup();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.persistCheck(
      orgId,
      checkName,
      "unavailable",
      { error: message.slice(0, 4000) },
      dependencies.now(),
    );
    if (shouldPublishTransition(previous, "unavailable")) {
      await dependencies.publish(orgId, {
        status: "succeeded",
        title: "Backup protection monitor is unavailable",
        body: message.slice(0, 4000),
        mood: "act",
        payload: { level: "unavailable", error: message.slice(0, 4000) },
        scope: "openneko_ops_backup_health",
        topic: "backup_freshness",
        freshnessTtlSeconds: 15 * 60,
      });
    }
    throw error;
  }
  const now = dependencies.now();
  const level = recordsBackupHealthLevel(sample, now);
  await dependencies.persistCheck(
    orgId,
    checkName,
    level,
    sample as unknown as Record<string, unknown>,
    new Date(sample.sampledAt),
  );
  if (!shouldPublishTransition(previous, level)) return { level, findings: 0 };
  const recovered = level === "ok";
  await dependencies.publish(orgId, {
    status: "succeeded",
    title: recovered
      ? "Whole-deployment backup protection recovered"
      : level === "warning"
        ? "Whole-deployment backup is approaching its freshness limit"
        : "Whole-deployment backup protection needs attention",
    body: `Latest backup: ${duration(recordsHealthAge(sample.lastBackupAt, now))} old; restore verification: ${duration(recordsHealthAge(sample.lastVerificationAt, now))} old.${sample.error ? ` ${sample.error}` : ""}`,
    mood: recovered ? "good" : level === "warning" ? "watch" : "act",
    payload: { level, previousLevel: previous, ...sample },
    scope: "openneko_ops_backup_health",
    topic: "backup_freshness",
    freshnessTtlSeconds: 15 * 60,
  });
  return { level, findings: 1 };
}

async function watchRecordsJobHealth(
  orgId: string,
  dependencies: RecordsOpsWatchDependencies,
): Promise<{ level: PersistedLevel; findings: number }> {
  if (!dependencies.sampleJobs) return { level: "ok", findings: 0 };
  const checkName = "jobs:records";
  const previous = await dependencies.previousCheck(orgId, checkName);
  let sample: RecordsJobHealthSample;
  try {
    sample = await dependencies.sampleJobs(orgId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await dependencies.persistCheck(
      orgId,
      checkName,
      "unavailable",
      { error: message.slice(0, 4000) },
      dependencies.now(),
    );
    if (shouldPublishTransition(previous, "unavailable")) {
      await dependencies.publish(orgId, {
        status: "succeeded",
        title: "Records job monitor is unavailable",
        body: message.slice(0, 4000),
        mood: "act",
        payload: { level: "unavailable", error: message.slice(0, 4000) },
        scope: "openneko_ops_records_jobs",
        topic: "records_job_health",
        freshnessTtlSeconds: 15 * 60,
      });
    }
    throw error;
  }
  const level: RecordsStorageLevel =
    sample.stalled.length > 0
      ? "critical"
      : sample.failedRecent.length > 0
        ? "warning"
        : "ok";
  await dependencies.persistCheck(
    orgId,
    checkName,
    level,
    sample as unknown as Record<string, unknown>,
    new Date(sample.sampledAt),
  );
  if (!shouldPublishTransition(previous, level)) return { level, findings: 0 };
  const recovered = level === "ok";
  await dependencies.publish(orgId, {
    status: "succeeded",
    title: recovered
      ? "Records job health recovered"
      : sample.stalled.length > 0
        ? `${sample.stalled.length} records job${sample.stalled.length === 1 ? " appears" : "s appear"} stalled`
        : `${sample.failedRecent.length} records job${sample.failedRecent.length === 1 ? " failed" : "s failed"} in the last 24 hours`,
    body: recovered
      ? "No stalled or recently failed records imports, exports, syncs, or cutovers remain."
      : `${sample.stalled.length} stalled; ${sample.failedRecent.length} recently failed. Review the attached bounded job list before retrying.`,
    mood: recovered ? "good" : level === "warning" ? "watch" : "act",
    payload: { level, previousLevel: previous, ...sample },
    scope: "openneko_ops_records_jobs",
    topic: "records_job_health",
    freshnessTtlSeconds: 15 * 60,
  });
  return { level, findings: 1 };
}

export async function runRecordsOpsWatch(
  orgId: string,
  dependencies: RecordsOpsWatchDependencies = defaultRecordsOpsWatchDependencies,
): Promise<{
  levels: Record<Volume, PersistedLevel>;
  backupLevel: PersistedLevel;
  jobsLevel: PersistedLevel;
  findings: number;
}> {
  const previous = await dependencies.previous(orgId);
  let sample: RecordsStorageSample;
  try {
    sample = await dependencies.sample();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const levels = {
      metadata: "unavailable",
      records: "unavailable",
      staging: "unavailable",
    } as const;
    await dependencies.persist(orgId, null, levels);
    if (VOLUMES.some((volume) => previous[volume] !== "unavailable")) {
      await dependencies.publish(orgId, {
        status: "succeeded",
        title: "Storage capacity monitor is unavailable",
        body: message.slice(0, 4000),
        mood: "act",
        payload: { levels, error: message.slice(0, 4000) },
        scope: "openneko_ops_storage",
        topic: "capacity_monitor",
        freshnessTtlSeconds: 15 * 60,
      });
    }
    throw error;
  }

  const levels = recordsStorageLevels(sample);
  await dependencies.persist(orgId, sample, levels);
  let findings = 0;
  for (const volume of VOLUMES) {
    const before = previous[volume];
    const after = levels[volume];
    if (before === after || (before === undefined && after === "ok")) continue;
    const capacity = sample[volume];
    const recovered = after === "ok";
    await dependencies.publish(orgId, {
      status: "succeeded",
      title: recovered
        ? `${volume} storage recovered`
        : `${volume} storage reached the ${levelLabel(after)} watermark`,
      body: `${(capacity.freeBytes / 1024 ** 3).toFixed(1)} GiB free; ${capacity.usedPercent.toFixed(1)}% used.`,
      mood: recovered ? "good" : after === "warning" ? "watch" : "act",
      payload: {
        volume,
        previousLevel: before ?? null,
        level: after,
        sampledAt: sample.sampledAt,
        ...capacity,
      },
      scope: `openneko_ops_storage_${volume}`,
      topic: "capacity_watermark",
      freshnessTtlSeconds: 15 * 60,
    });
    findings += 1;
  }
  const backup = await watchBackupHealth(orgId, dependencies);
  const jobs = await watchRecordsJobHealth(orgId, dependencies);
  return {
    levels,
    backupLevel: backup.level,
    jobsLevel: jobs.level,
    findings: findings + backup.findings + jobs.findings,
  };
}
