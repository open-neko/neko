import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, contentDigest, shortDigest } from "./canonical";
import {
  AttemptSchema,
  EpisodeSchema,
  ManifestSchema,
  OracleJournalSchema,
  type EvalAttempt,
  type EvalEpisode,
  type EvalManifest,
} from "./schemas";

type LockDocument = {
  schemaVersion: "openneko.eval.lock/v1";
  runId: string;
  pid: number;
  hostname: string;
  nonce: string;
  acquiredAt: string;
};

export type RunLock = {
  path: string;
  release(): Promise<void>;
};

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonReplace(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function writeJsonExclusive(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function isLocalPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class EvalStateStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  manifestPath(runId: string): string {
    return join(this.runDir(runId), "manifest.json");
  }

  private slotStem(slotKey: string): string {
    return shortDigest(slotKey);
  }

  episodePath(runId: string, slotKey: string): string {
    return join(this.runDir(runId), "episodes", `${this.slotStem(slotKey)}.json`);
  }

  attemptPath(
    runId: string,
    slotKey: string,
    attempt: number,
    event: EvalAttempt["event"],
  ): string {
    return join(
      this.runDir(runId),
      "attempts",
      `${this.slotStem(slotKey)}-attempt-${attempt}.${event}.json`,
    );
  }

  oraclePath(runId: string): string {
    return join(this.runDir(runId), "oracles.json");
  }

  partialReportPath(runId: string): string {
    return join(this.runDir(runId), "partial-report.json");
  }

  async initialize(manifest: EvalManifest): Promise<void> {
    ManifestSchema.parse(manifest);
    await mkdir(join(this.runDir(manifest.runId), "attempts"), { recursive: true });
    await mkdir(join(this.runDir(manifest.runId), "episodes"), { recursive: true });
    await writeJsonExclusive(this.manifestPath(manifest.runId), manifest);
  }

  async readManifest(runId: string): Promise<EvalManifest> {
    return ManifestSchema.parse(
      JSON.parse(await readFile(this.manifestPath(runId), "utf8")),
    );
  }

  async replaceManifest(manifest: EvalManifest): Promise<void> {
    ManifestSchema.parse(manifest);
    await writeJsonReplace(this.manifestPath(manifest.runId), manifest);
  }

  async findCompatibleIncomplete(
    compatibility: EvalManifest["compatibility"],
  ): Promise<EvalManifest | undefined> {
    const runsPath = join(this.root, "runs");
    let entries: string[];
    try {
      entries = await readdir(runsPath);
    } catch {
      return undefined;
    }
    const candidates: EvalManifest[] = [];
    for (const entry of entries) {
      try {
        const manifest = await this.readManifest(entry);
        if (
          manifest.status === "in_progress" &&
          canonicalJson(manifest.compatibility) === canonicalJson(compatibility)
        ) {
          candidates.push(manifest);
        }
      } catch {
        // A corrupt or unrelated directory is never silently reused.
      }
    }
    return candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  async writeAttempt(attempt: EvalAttempt): Promise<void> {
    AttemptSchema.parse(attempt);
    await writeJsonExclusive(
      this.attemptPath(attempt.runId, attempt.slotKey, attempt.attempt, attempt.event),
      attempt,
    );
  }

  async nextAttemptNumber(runId: string, slotKey: string): Promise<number> {
    const attemptsPath = join(this.runDir(runId), "attempts");
    const prefix = `${this.slotStem(slotKey)}-attempt-`;
    let entries: string[] = [];
    try {
      entries = await readdir(attemptsPath);
    } catch {
      return 1;
    }
    let largest = 0;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const value = Number(entry.slice(prefix.length).split(".")[0]);
      if (Number.isInteger(value)) largest = Math.max(largest, value);
    }
    return largest + 1;
  }

  async writeEpisode(
    episode: Omit<EvalEpisode, "integrityDigest">,
  ): Promise<EvalEpisode> {
    const integrityDigest = contentDigest(episode);
    const complete = EpisodeSchema.parse({ ...episode, integrityDigest });
    await writeJsonExclusive(this.episodePath(episode.runId, episode.slotKey), complete);
    return complete;
  }

  async readEpisode(runId: string, slotKey: string): Promise<EvalEpisode | undefined> {
    const path = this.episodePath(runId, slotKey);
    if (!(await exists(path))) return undefined;
    const episode = EpisodeSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const { integrityDigest, ...unsigned } = episode;
    if (contentDigest(unsigned) !== integrityDigest) {
      throw new Error(`episode integrity mismatch for ${slotKey}`);
    }
    if (episode.slotKey !== slotKey || episode.runId !== runId) {
      throw new Error(`episode identity mismatch for ${slotKey}`);
    }
    return episode;
  }

  async writeOracles(
    runId: string,
    document: { schemaVersion: "openneko.eval.oracles/v1"; digest: string; values: unknown },
  ): Promise<void> {
    await writeJsonExclusive(this.oraclePath(runId), OracleJournalSchema.parse(document));
  }

  async readOracles(runId: string): Promise<{
    schemaVersion: "openneko.eval.oracles/v1";
    digest: string;
    values: unknown;
  }> {
    const parsed = OracleJournalSchema.parse(
      JSON.parse(await readFile(this.oraclePath(runId), "utf8")),
    );
    if (contentDigest(parsed.values) !== parsed.digest) {
      throw new Error(`oracle journal integrity mismatch for ${runId}`);
    }
    return parsed;
  }

  async writePartialReport(runId: string, report: unknown): Promise<void> {
    await writeJsonReplace(this.partialReportPath(runId), report);
  }

  async acquireLock(runId: string): Promise<RunLock> {
    const locksDir = join(this.root, "locks");
    const path = join(locksDir, `${runId}.lock`);
    await mkdir(locksDir, { recursive: true });
    const document: LockDocument = {
      schemaVersion: "openneko.eval.lock/v1",
      runId,
      pid: process.pid,
      hostname: hostname(),
      nonce: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };

    for (let pass = 0; pass < 2; pass += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
        await handle.close();
        return {
          path,
          release: async () => {
            try {
              const current = JSON.parse(await readFile(path, "utf8")) as LockDocument;
              if (current.nonce === document.nonce) await unlink(path);
            } catch {
              // Lock already disappeared or was replaced; do not delete a new owner.
            }
          },
        };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        let current: LockDocument | undefined;
        try {
          current = JSON.parse(await readFile(path, "utf8")) as LockDocument;
        } catch {
          // Broken lock documents are stale by definition.
        }
        const stale =
          !current ||
          (current.hostname === hostname() && !isLocalPidRunning(current.pid));
        if (!stale) {
          throw new Error(
            `eval run ${runId} is locked by pid ${current?.pid ?? "unknown"} on ${current?.hostname ?? "unknown"}`,
          );
        }
        await unlink(path).catch(() => {});
      }
    }
    throw new Error(`could not acquire eval run lock ${runId}`);
  }
}
