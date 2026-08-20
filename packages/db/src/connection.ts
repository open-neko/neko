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
  const environmentFirst = nonEmptyEnv("OPENNEKO_PG_ENV_OVERRIDE") === "1";
  const choose = <T>(environmentValue: T | undefined, localValue: T | undefined): T | undefined =>
    environmentFirst ? environmentValue ?? localValue : localValue ?? environmentValue;
  const poolCfg: PoolConfig = {
    host: choose(nonEmptyEnv("NEKO_PG_HOST"), cfg.host) ?? DEFAULT_PG.host,
    port: choose(envPort(), cfg.port) ?? DEFAULT_PG.port,
    user: choose(nonEmptyEnv("NEKO_PG_USER"), cfg.user) ?? DEFAULT_PG.user,
    password:
      choose(nonEmptyEnv("NEKO_PG_PASSWORD"), cfg.password) ?? DEFAULT_PG.password,
    database:
      overrides.database ??
      choose(nonEmptyEnv("NEKO_PG_DATABASE"), cfg.database) ??
      DEFAULT_PG.database,
    max: 10,
  };

  if (choose(nonEmptyEnv("NEKO_PG_SSLMODE"), cfg.sslmode) === "require") {
    poolCfg.ssl = { rejectUnauthorized: false };
  }

  return poolCfg;
}
