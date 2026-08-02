/**
 * Postgres pool config builder.
 *
 * The connection details come from `~/.config/openneko/config.json`
 * (written by /setup), then `NEKO_PG_*` environment variables, then
 * hardcoded defaults that match what the docker compose stack ships with:
 *
 *   user      = "neko"
 *   password  = "secret"      ← initial / unchanged
 *   host      = "localhost"
 *   port      = 5432
 *   database  = "neko"
 *
 * On first boot the config file doesn't exist; the app connects with the
 * defaults. The /setup wizard's "Set DB password" step calls
 * `ALTER USER neko WITH PASSWORD '<new>'` and writes the new password to
 * the config file. From then on the file's value takes precedence.
 *
 * Production deploys can either pre-populate `~/.config/openneko/config.json`
 * or provide `NEKO_PG_*` directly. The local file wins so a password rotated
 * through /setup remains authoritative.
 *
 * `sslmode: "require"` in the config enables TLS with `rejectUnauthorized:
 * false` (matches Cloud SQL public-IP usage with its self-signed CA).
 */

import type { PoolConfig } from "pg";
import { readLocalConfig } from "./local-config";

const DEFAULT_PG = {
  host: "localhost",
  port: 5432,
  user: "neko",
  password: "secret",
  database: "neko",
} as const;

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envPort(): number | undefined {
  const value = nonEmptyEnv("NEKO_PG_PORT") ?? nonEmptyEnv("OPENNEKO_DB_PORT");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535
    ? parsed
    : undefined;
}

export function buildPoolConfig(overrides: { database?: string } = {}): PoolConfig {
  const cfg = readLocalConfig().pg ?? {};
  const poolCfg: PoolConfig = {
    host: cfg.host ?? nonEmptyEnv("NEKO_PG_HOST") ?? DEFAULT_PG.host,
    port: cfg.port ?? envPort() ?? DEFAULT_PG.port,
    user: cfg.user ?? nonEmptyEnv("NEKO_PG_USER") ?? DEFAULT_PG.user,
    password:
      cfg.password ?? nonEmptyEnv("NEKO_PG_PASSWORD") ?? DEFAULT_PG.password,
    database:
      overrides.database ??
      cfg.database ??
      nonEmptyEnv("NEKO_PG_DATABASE") ??
      DEFAULT_PG.database,
    max: 10,
  };

  if ((cfg.sslmode ?? nonEmptyEnv("NEKO_PG_SSLMODE")) === "require") {
    poolCfg.ssl = { rejectUnauthorized: false };
  }

  return poolCfg;
}
