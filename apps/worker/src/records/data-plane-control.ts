import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const CONTROL_FILENAME = ".records-graphjin-control";
const RELOAD_FILENAME = ".records-graphjin-reload";

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

async function atomicWrite(file: string, content: string): Promise<void> {
  const staging = `${file}.${randomUUID()}.tmp`;
  const handle = await open(staging, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(staging, file);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
}

export class RecordsDataPlaneTransitionError extends Error {
  readonly code = "records_data_plane_transition_failed";

  constructor(message: string) {
    super(message);
    this.name = "RecordsDataPlaneTransitionError";
  }
}

/**
 * Cross-container control for the records-only GraphJin child. The worker and
 * wrapper share a volume; the wrapper is read-only and can only act on the
 * worker-authored state. Waiting on the HTTP endpoint proves the process has
 * actually crossed the requested serving boundary.
 */
export class RecordsDataPlaneController {
  readonly controlFile: string;
  readonly reloadFile: string;

  constructor(
    private readonly options: {
      configDirectory: string;
      baseUrl: string;
      timeoutMs?: number;
      pollMs?: number;
      fetch?: FetchLike;
    },
  ) {
    this.controlFile = join(options.configDirectory, CONTROL_FILENAME);
    this.reloadFile = join(options.configDirectory, RELOAD_FILENAME);
  }

  private async endpointAlive(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(this.options.pollMs ?? 250, 1_000),
    );
    try {
      await (this.options.fetch ?? fetch)(
        new URL("/api/v1/graphql", this.options.baseUrl),
        { method: "GET", signal: controller.signal },
      );
      // Authentication and method errors still prove that GraphJin is
      // accepting requests, which is the process-state fact needed here.
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForAlive(expected: boolean): Promise<void> {
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const pollMs = this.options.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if ((await this.endpointAlive()) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new RecordsDataPlaneTransitionError(
      expected
        ? "records GraphJin did not become ready after policy projection"
        : "records GraphJin did not stop before schema application",
    );
  }

  async setReady(ready: boolean, reason: string): Promise<void> {
    await mkdir(this.options.configDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(
      this.controlFile,
      `${ready ? "ready" : "stopped"}\n# ${reason.replace(/[\r\n]+/g, " ")}\n`,
    );
    await this.waitForAlive(ready);
  }

  async requestReload(): Promise<void> {
    await mkdir(this.options.configDirectory, { recursive: true, mode: 0o700 });
    await atomicWrite(this.reloadFile, `${randomUUID()}\n`);
  }

  async requestedState(): Promise<"ready" | "stopped" | null> {
    const content = await readFile(this.controlFile, "utf8").catch(() => "");
    const state = content.split(/\r?\n/, 1)[0];
    return state === "ready" || state === "stopped" ? state : null;
  }
}
