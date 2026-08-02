import { statfs } from "node:fs/promises";

export type RecordsStorageLevel = "ok" | "warning" | "critical" | "hard_stop";

export type RecordsStorageSnapshot = {
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
};

export type RecordsStorageSample = {
  sampledAt: string;
  metadata: RecordsStorageSnapshot;
  records: RecordsStorageSnapshot;
  staging: RecordsStorageSnapshot;
};

export type RecordsStorageThresholds = {
  warningPercent: number;
  criticalPercent: number;
  hardStopPercent: number;
  warningFreeBytes: number;
  criticalFreeBytes: number;
  hardStopFreeBytes: number;
};

export class RecordsStorageBackpressureError extends Error {
  readonly code = "records_storage_backpressure";
  readonly retryable = true;

  constructor(
    readonly volume: keyof Omit<RecordsStorageSample, "sampledAt">,
    readonly level: Exclude<RecordsStorageLevel, "ok">,
    readonly snapshot: RecordsStorageSnapshot,
    readonly requiredBytes: number,
  ) {
    super(
      `${volume} storage is ${level.replace("_", " ")}: ${snapshot.freeBytes} bytes free; ${requiredBytes} bytes of headroom required`,
    );
    this.name = "RecordsStorageBackpressureError";
  }
}

const GIB = 1024 ** 3;

function numericEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function recordsStorageThresholds(
  env: NodeJS.ProcessEnv = process.env,
): RecordsStorageThresholds {
  const thresholds = {
    warningPercent: numericEnv(env, "OPENNEKO_STORAGE_WARNING_PERCENT", 80, 1, 99),
    criticalPercent: numericEnv(env, "OPENNEKO_STORAGE_CRITICAL_PERCENT", 90, 1, 99),
    hardStopPercent: numericEnv(env, "OPENNEKO_STORAGE_HARD_STOP_PERCENT", 95, 1, 100),
    warningFreeBytes: numericEnv(
      env,
      "OPENNEKO_STORAGE_WARNING_FREE_BYTES",
      5 * GIB,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    criticalFreeBytes: numericEnv(
      env,
      "OPENNEKO_STORAGE_CRITICAL_FREE_BYTES",
      2 * GIB,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    hardStopFreeBytes: numericEnv(
      env,
      "OPENNEKO_STORAGE_HARD_STOP_FREE_BYTES",
      GIB,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (
    thresholds.warningPercent >= thresholds.criticalPercent ||
    thresholds.criticalPercent >= thresholds.hardStopPercent ||
    thresholds.warningFreeBytes <= thresholds.criticalFreeBytes ||
    thresholds.criticalFreeBytes <= thresholds.hardStopFreeBytes
  ) {
    throw new Error("records storage thresholds must become stricter from warning to hard stop");
  }
  return thresholds;
}

function snapshot(raw: { blocks: number; bavail: number; bsize: number }): RecordsStorageSnapshot {
  const totalBytes = raw.blocks * raw.bsize;
  const freeBytes = raw.bavail * raw.bsize;
  if (
    !Number.isSafeInteger(totalBytes) ||
    !Number.isSafeInteger(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    throw new Error("storage capacity sample is invalid");
  }
  return {
    totalBytes,
    freeBytes,
    usedPercent: ((totalBytes - freeBytes) / totalBytes) * 100,
  };
}

function parsedSnapshot(value: unknown, label: string): RecordsStorageSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} storage sample is invalid`);
  }
  const raw = value as Record<string, unknown>;
  const candidate = {
    totalBytes: Number(raw.totalBytes),
    freeBytes: Number(raw.freeBytes),
    usedPercent: Number(raw.usedPercent),
  };
  if (
    !Number.isSafeInteger(candidate.totalBytes) ||
    !Number.isSafeInteger(candidate.freeBytes) ||
    candidate.totalBytes <= 0 ||
    candidate.freeBytes < 0 ||
    candidate.freeBytes > candidate.totalBytes ||
    !Number.isFinite(candidate.usedPercent) ||
    candidate.usedPercent < 0 ||
    candidate.usedPercent > 100
  ) {
    throw new Error(`${label} storage sample is invalid`);
  }
  return candidate;
}

function levelFor(
  value: RecordsStorageSnapshot,
  thresholds: RecordsStorageThresholds,
): RecordsStorageLevel {
  if (
    value.usedPercent >= thresholds.hardStopPercent ||
    value.freeBytes <= thresholds.hardStopFreeBytes
  ) {
    return "hard_stop";
  }
  if (
    value.usedPercent >= thresholds.criticalPercent ||
    value.freeBytes <= thresholds.criticalFreeBytes
  ) {
    return "critical";
  }
  if (
    value.usedPercent >= thresholds.warningPercent ||
    value.freeBytes <= thresholds.warningFreeBytes
  ) {
    return "warning";
  }
  return "ok";
}

function projected(
  value: RecordsStorageSnapshot,
  requiredBytes: number,
): RecordsStorageSnapshot {
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
    throw new Error("storage headroom estimate must be a non-negative safe integer");
  }
  const freeBytes = Math.max(0, value.freeBytes - requiredBytes);
  return {
    totalBytes: value.totalBytes,
    freeBytes,
    usedPercent: ((value.totalBytes - freeBytes) / value.totalBytes) * 100,
  };
}

export class RecordsStorageMonitor {
  private cached: { expiresAt: number; sample: RecordsStorageSample } | null = null;
  private pending: Promise<RecordsStorageSample> | null = null;

  constructor(
    private readonly options: {
      endpoint?: string;
      fallbackPath: string;
      thresholds?: RecordsStorageThresholds;
      fetch?: typeof fetch;
      statfs?: typeof statfs;
      now?: () => Date;
      cacheMs?: number;
    },
  ) {}

  private thresholds(): RecordsStorageThresholds {
    return this.options.thresholds ?? recordsStorageThresholds();
  }

  private async loadSample(): Promise<RecordsStorageSample> {
    if (this.options.endpoint) {
      const response = await (this.options.fetch ?? fetch)(
        new URL("/v1/storage", this.options.endpoint),
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!response.ok) {
        throw new Error(`records storage monitor returned HTTP ${response.status}`);
      }
      const value = (await response.json()) as Record<string, unknown>;
      return {
        sampledAt:
          typeof value.sampledAt === "string" ? value.sampledAt : new Date().toISOString(),
        metadata: parsedSnapshot(value.metadata, "metadata"),
        records: parsedSnapshot(value.records, "records"),
        staging: parsedSnapshot(value.staging, "staging"),
      };
    }
    const raw = await (this.options.statfs ?? statfs)(this.options.fallbackPath);
    const local = snapshot({
      blocks: Number(raw.blocks),
      bavail: Number(raw.bavail),
      bsize: Number(raw.bsize),
    });
    return {
      sampledAt: (this.options.now ?? (() => new Date()))().toISOString(),
      metadata: local,
      records: local,
      staging: local,
    };
  }

  async sample(): Promise<RecordsStorageSample> {
    const cacheMs = this.options.cacheMs ?? 5_000;
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.sample;
    if (this.pending) return this.pending;
    this.pending = this.loadSample()
      .then((sample) => {
        this.cached = { expiresAt: Date.now() + cacheMs, sample };
        return sample;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  async assertBulkAllowed(input: {
    stagingBytes?: number;
    recordsBytes?: number;
  } = {}): Promise<RecordsStorageSample> {
    const sample = await this.sample();
    const thresholds = this.thresholds();
    for (const [volume, requiredBytes] of [
      ["staging", input.stagingBytes ?? 0],
      ["records", input.recordsBytes ?? 0],
    ] as const) {
      const current = sample[volume];
      const currentLevel = levelFor(current, thresholds);
      const next = projected(current, requiredBytes);
      const projectedLevel = levelFor(next, thresholds);
      const level =
        currentLevel === "hard_stop" || projectedLevel === "hard_stop"
          ? "hard_stop"
          : currentLevel === "critical" || projectedLevel === "critical"
            ? "critical"
            : null;
      if (level) {
        throw new RecordsStorageBackpressureError(volume, level, current, requiredBytes);
      }
    }
    return sample;
  }

  async assertInteractiveWritesAllowed(): Promise<RecordsStorageSample> {
    const sample = await this.sample();
    const thresholds = this.thresholds();
    const level = levelFor(sample.records, thresholds);
    if (level === "hard_stop") {
      throw new RecordsStorageBackpressureError("records", level, sample.records, 0);
    }
    return sample;
  }
}

export function createRecordsStorageMonitor(
  fallbackPath: string = process.cwd(),
): RecordsStorageMonitor {
  return new RecordsStorageMonitor({
    endpoint: process.env.OPENNEKO_RECORDS_OPS_URL,
    fallbackPath,
  });
}

export function estimateSalesforceFootprint(payload: Record<string, unknown>): {
  stagingBytes: number;
  recordsBytes: number;
} {
  const inventory =
    typeof payload.salesforce_inventory === "object" &&
    payload.salesforce_inventory !== null &&
    !Array.isArray(payload.salesforce_inventory)
      ? (payload.salesforce_inventory as Record<string, unknown>)
      : null;
  const objects = Array.isArray(inventory?.objects) ? inventory.objects : [];
  let stagingBytes = 0;
  for (const value of objects) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const object = value as Record<string, unknown>;
    const rows = Number(object.estimatedRows);
    const fields = Number(object.fields);
    if (!Number.isSafeInteger(rows) || rows < 0) continue;
    const estimatedRowBytes =
      Number.isSafeInteger(fields) && fields > 0 ? Math.max(256, fields * 64) : 1_024;
    stagingBytes += rows * estimatedRowBytes;
    if (!Number.isSafeInteger(stagingBytes)) {
      throw new Error("Salesforce storage estimate exceeds the supported range");
    }
  }
  stagingBytes = Math.max(stagingBytes, 64 * 1024 ** 2);
  const recordsBytes = stagingBytes * 3;
  if (!Number.isSafeInteger(recordsBytes)) {
    throw new Error("Salesforce records footprint estimate exceeds the supported range");
  }
  return { stagingBytes, recordsBytes };
}
