import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type Pool, type PoolConfig } from "pg";

const RECORDS_MIGRATION_LOCK = "record-engine-migrations-v1";
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export type RecordsMigration = {
  name: string;
  sql: string;
  checksumSha256: string;
};

export type RecordsMigrationResult = {
  applied: string[];
  current: string | null;
};

export function buildRecordsPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: { database?: string } = {},
): PoolConfig {
  const port = Number.parseInt(env.RECORDS_PG_PORT ?? "5434", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid RECORDS_PG_PORT: ${env.RECORDS_PG_PORT ?? ""}`);
  }

  const config: PoolConfig = {
    host: env.RECORDS_PG_HOST ?? "localhost",
    port,
    user: env.RECORDS_PG_USER ?? "records",
    password: env.RECORDS_PG_PASSWORD ?? "records-secret",
    database: overrides.database ?? env.RECORDS_PG_DATABASE ?? "records",
    max: 5,
  };
  if (env.RECORDS_PG_SSLMODE === "require") {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export function defaultRecordsMigrationsDir(cwd = process.cwd()): string {
  const deployed = resolve(cwd, "db", "records", "migrations");
  if (existsSync(deployed)) return deployed;

  // Source-workspace fallback: pnpm runs a package script with cwd set to the
  // package directory, while the canonical migrations remain at repo/db.
  const sourceWorkspace = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "db",
    "records",
    "migrations",
  );
  return existsSync(sourceWorkspace) ? sourceWorkspace : deployed;
}

export async function discoverRecordsMigrations(
  directory = process.env.OPENNEKO_RECORDS_MIGRATIONS_DIR ?? defaultRecordsMigrationsDir(),
): Promise<RecordsMigration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    if (!MIGRATION_FILE.test(name)) {
      throw new Error(`invalid records migration filename: ${name}`);
    }
  }

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      if (sql.trim() === "") {
        throw new Error(`empty records migration: ${name}`);
      }
      return {
        name,
        sql,
        checksumSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      };
    }),
  );
}

export async function runRecordsMigrations(options: {
  pool?: Pool;
  directory?: string;
  log?: (message: string) => void;
} = {}): Promise<RecordsMigrationResult> {
  const ownedPool = options.pool ? null : new pg.Pool(buildRecordsPoolConfig());
  const pool = options.pool ?? ownedPool!;
  const client = await pool.connect();
  const log = options.log ?? (() => {});
  const applied: string[] = [];

  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      RECORDS_MIGRATION_LOCK,
    ]);
    await client.query("create schema if not exists engine");
    await client.query(`
      create table if not exists engine.schema_migrations (
        name text primary key,
        checksum_sha256 text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const migrations = await discoverRecordsMigrations(options.directory);
    const stored = await client.query<{ name: string; checksum_sha256: string }>(
      "select name, checksum_sha256 from engine.schema_migrations order by name",
    );
    const checksums = new Map(
      stored.rows.map((row) => [row.name, row.checksum_sha256]),
    );

    for (const migration of migrations) {
      const existing = checksums.get(migration.name);
      if (existing !== undefined) {
        if (existing !== migration.checksumSha256) {
          throw new Error(
            `records migration checksum mismatch for ${migration.name}: database=${existing} disk=${migration.checksumSha256}`,
          );
        }
        continue;
      }

      log(`[records-migrate] applying ${migration.name}`);
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          `insert into engine.schema_migrations (name, checksum_sha256)
           values ($1, $2)`,
          [migration.name, migration.checksumSha256],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      applied.push(migration.name);
    }

    const current = migrations.at(-1)?.name ?? null;
    log(`[records-migrate] done — ${applied.length} applied; current=${current ?? "none"}`);
    return { applied, current };
  } finally {
    try {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [
        RECORDS_MIGRATION_LOCK,
      ]);
    } finally {
      client.release();
      if (ownedPool) await ownedPool.end();
    }
  }
}
