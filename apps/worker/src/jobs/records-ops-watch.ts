import { and, db, eq, inArray, records_ops_health } from "@neko/db";
import {
  createRecordsStorageMonitor,
  recordsStorageLevels,
  type RecordsStorageLevel,
  type RecordsStorageSample,
} from "../records/storage-health.js";
import { publishRecordsOpsFinding } from "./records-ops-finding.js";

const VOLUMES = ["metadata", "records", "staging"] as const;
type Volume = (typeof VOLUMES)[number];
type PersistedLevel = RecordsStorageLevel | "unavailable";

export type RecordsOpsWatchDependencies = {
  sample: () => Promise<RecordsStorageSample>;
  previous: (orgId: string) => Promise<Partial<Record<Volume, PersistedLevel>>>;
  persist: (
    orgId: string,
    sample: RecordsStorageSample | null,
    levels: Record<Volume, PersistedLevel>,
  ) => Promise<void>;
  publish: typeof publishRecordsOpsFinding;
};

export const defaultRecordsOpsWatchDependencies: RecordsOpsWatchDependencies = {
  sample: () => createRecordsStorageMonitor().sample(),
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
  publish: publishRecordsOpsFinding,
};

function levelLabel(level: PersistedLevel): string {
  return level.replace("_", " ");
}

export async function runRecordsOpsWatch(
  orgId: string,
  dependencies: RecordsOpsWatchDependencies = defaultRecordsOpsWatchDependencies,
): Promise<{ levels: Record<Volume, PersistedLevel>; findings: number }> {
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
  return { levels, findings };
}
