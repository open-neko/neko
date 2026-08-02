import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRecordsPoolConfig,
  discoverRecordsMigrations,
} from "../src/records-migrate";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function migrationDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "records-migrations-"));
  tempDirs.push(directory);
  return directory;
}

describe("buildRecordsPoolConfig", () => {
  it("uses host-development defaults without consulting metadata config", () => {
    expect(buildRecordsPoolConfig({})).toMatchObject({
      host: "localhost",
      port: 5434,
      user: "records",
      password: "records-secret",
      database: "records",
    });
  });

  it("reads the dedicated records environment and validates the port", () => {
    expect(
      buildRecordsPoolConfig({
        RECORDS_PG_HOST: "records-db",
        RECORDS_PG_PORT: "5432",
        RECORDS_PG_USER: "worker",
        RECORDS_PG_PASSWORD: "pw",
        RECORDS_PG_DATABASE: "business",
        RECORDS_PG_SSLMODE: "require",
      }),
    ).toMatchObject({
      host: "records-db",
      port: 5432,
      user: "worker",
      password: "pw",
      database: "business",
      ssl: { rejectUnauthorized: false },
    });
    expect(() => buildRecordsPoolConfig({ RECORDS_PG_PORT: "nope" })).toThrow(
      /RECORDS_PG_PORT/,
    );
  });
});

describe("discoverRecordsMigrations", () => {
  it("sorts migrations and computes stable checksums", async () => {
    const directory = await migrationDir();
    await writeFile(join(directory, "0002_second.sql"), "select 2;\n");
    await writeFile(join(directory, "0001_first.sql"), "select 1;\n");

    const migrations = await discoverRecordsMigrations(directory);
    expect(migrations.map((migration) => migration.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(migrations[0]?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.checksumSha256).not.toBe(
      migrations[1]?.checksumSha256,
    );
  });

  it("rejects malformed and empty migration files", async () => {
    const malformed = await migrationDir();
    await writeFile(join(malformed, "notes.sql"), "select 1;\n");
    await expect(discoverRecordsMigrations(malformed)).rejects.toThrow(
      /invalid records migration filename/,
    );

    const empty = await migrationDir();
    await writeFile(join(empty, "0001_empty.sql"), "  \n");
    await expect(discoverRecordsMigrations(empty)).rejects.toThrow(
      /empty records migration/,
    );
  });
});
