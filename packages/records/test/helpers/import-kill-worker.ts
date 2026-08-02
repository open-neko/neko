import { readFile } from "node:fs/promises";
import pg from "pg";
import { buildRecordsPoolConfig } from "@neko/db/records-migrate";
import {
  mintRecordsGraphjinToken,
  RecordsGraphjinClient,
  type RecordsGraphjinExecuteInput,
  type RecordsGraphjinTransport,
} from "../../src/graphjin/client";
import { RecordImportExecutor } from "../../src/import/executor";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const mode = requiredEnv("RECORDS_IMPORT_KILL_MODE");
if (mode !== "before" && mode !== "after") {
  throw new Error("RECORDS_IMPORT_KILL_MODE must be before or after");
}

class KillAtNextMutation implements RecordsGraphjinTransport {
  constructor(private readonly inner: RecordsGraphjinTransport) {}

  async execute<T>(input: RecordsGraphjinExecuteInput): Promise<T> {
    if (input.operationName !== "RecordsImportBatch") {
      return this.inner.execute<T>(input);
    }
    if (mode === "before") this.kill();
    const result = await this.inner.execute<T>(input);
    this.kill();
  }

  private kill(): never {
    process.kill(process.pid, "SIGKILL");
    throw new Error("SIGKILL did not terminate import worker");
  }
}

const database = requiredEnv("RECORDS_IMPORT_TEST_DATABASE");
const sourceFile = requiredEnv("RECORDS_IMPORT_TEST_SOURCE");
const jwtSecret = requiredEnv("RECORDS_IMPORT_TEST_JWT_SECRET");
const pool = new pg.Pool(buildRecordsPoolConfig(process.env, { database }));
const graphjin = new RecordsGraphjinClient({
  baseUrl: requiredEnv("RECORDS_IMPORT_TEST_GRAPHJIN_URL"),
});
const executor = new RecordImportExecutor({
  pool,
  graphjin: new KillAtNextMutation(graphjin),
  serviceToken: (orgId) =>
    mintRecordsGraphjinToken({
      secret: jwtSecret,
      orgId,
      userId: "records-service",
      role: "service",
    }),
  leaseOwner: requiredEnv("RECORDS_IMPORT_TEST_LEASE_OWNER"),
  readSource: () => readFile(sourceFile),
});

await executor.execute({
  orgId: "org-a",
  importRunId: requiredEnv("RECORDS_IMPORT_TEST_RUN_ID"),
  actorUserId: "admin-1",
  leaseOwner: requiredEnv("RECORDS_IMPORT_TEST_LEASE_OWNER"),
});

await pool.end();
