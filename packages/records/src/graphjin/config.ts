import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify } from "yaml";
import {
  RECORD_GRAPHJIN_ROLES,
  type GraphjinRole,
} from "../policy/graphjin";
import { validateRecordIdentifier } from "../naming";

export const RECORDS_GRAPHJIN_VERSION = "3.18.42";
export const RECORDS_GRAPHJIN_CONFIG_FILENAME = "dev.yml";

const CONFIG_MODE = 0o600;
const LOCK_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const VALIDATION_TIMEOUT_MS = 30_000;

export type RecordsGraphjinDatabaseConfig = {
  connectionString: string;
  statementTimeoutMs?: number;
  poolSize?: number;
  maxConnections?: number;
};

export type RecordsGraphjinJwtConfig = {
  secret: string;
  audience?: string;
  issuer?: string;
};

export type BuildRecordsGraphjinConfigInput = {
  orgId: string;
  roles: GraphjinRole[];
  database: RecordsGraphjinDatabaseConfig;
  jwt: RecordsGraphjinJwtConfig;
  secretKey: string;
  rateLimit?: { rate: number; bucket: number };
  defaultLimit?: number;
};

export type RecordsGraphjinConfigValidator = (input: {
  configDirectory: string;
  configFile: string;
}) => Promise<void>;

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function validateOrgIdForRoleQuery(orgId: string): string {
  const value = orgId.trim();
  if (!value) throw new Error("records GraphJin config requires an org id");
  if (value !== orgId) {
    throw new Error("records GraphJin org id cannot have leading or trailing whitespace");
  }
  // GraphJin rejects non-ASCII roles_query text. Control characters would
  // also make a generated SQL string ambiguous, so reject rather than encode.
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new Error("records GraphJin org id must contain printable ASCII characters");
  }
  return value;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildRecordsGraphjinRoleQuery(orgId: string): string {
  const safeOrgId = validateOrgIdForRoleQuery(orgId);
  return (
    "SELECT role FROM engine.actor " +
    `WHERE user_id = $user_id AND org_id = ${sqlLiteral(safeOrgId)} ` +
    "AND disabled_at IS NULL"
  );
}

function postgresConnectionConfig(
  connectionString: string,
  timeoutMs: number,
): { connectionString: string; databaseName: string } {
  const value = connectionString.trim();
  if (!value) throw new Error("records GraphJin database connection string is required");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("records GraphJin database connection string must be a Postgres URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("records GraphJin database connection string must use postgres://");
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!databaseName || databaseName.includes("/")) {
    throw new Error("records GraphJin database connection string must name one database");
  }
  const timeout = validatePositiveInteger(timeoutMs, "statement timeout");
  const currentOptions = url.searchParams.get("options")?.trim() ?? "";
  const withoutStatementTimeout = currentOptions
    .split(/\s+-c\s+/)
    .filter((entry) => entry && !entry.startsWith("statement_timeout="))
    .map((entry, index) => (index === 0 && !currentOptions.startsWith("-c ") ? entry : `-c ${entry}`))
    .join(" ")
    .trim();
  url.searchParams.set(
    "options",
    `${withoutStatementTimeout}${withoutStatementTimeout ? " " : ""}-c statement_timeout=${timeout}`,
  );
  return { connectionString: url.toString(), databaseName };
}

function relationKey(table: { schema: string; name: string }): string {
  return `${table.schema}\u0000${table.name}`;
}

function assertExhaustiveRoles(roles: GraphjinRole[]): void {
  const expectedRoles = new Set<string>(RECORD_GRAPHJIN_ROLES);
  const seenRoles = new Set<string>();
  let expectedRelations: string[] | null = null;

  for (const role of roles) {
    if (!expectedRoles.has(role.name) || seenRoles.has(role.name)) {
      throw new Error(`invalid or duplicate records GraphJin role: ${role.name}`);
    }
    seenRoles.add(role.name);
    const expectedMatch =
      role.name === "member" || role.name === "admin" || role.name === "service"
        ? `role = '${role.name}'`
        : undefined;
    if (role.match !== expectedMatch) {
      throw new Error(`records GraphJin role ${role.name} has an invalid match expression`);
    }
    for (const table of role.tables) {
      validateRecordIdentifier(table.schema);
      validateRecordIdentifier(table.name);
    }
    const relations = role.tables.map(relationKey).sort();
    if (new Set(relations).size !== relations.length) {
      throw new Error(`records GraphJin role ${role.name} contains a duplicate table`);
    }
    if (expectedRelations === null) expectedRelations = relations;
    else if (expectedRelations.join("\u0000") !== relations.join("\u0000")) {
      throw new Error(`records GraphJin role ${role.name} does not cover the live catalog`);
    }

    for (const table of role.tables) {
      for (const operation of ["query", "insert", "update", "upsert", "delete"] as const) {
        const rule = table[operation];
        if (!rule || typeof rule.block !== "boolean") {
          throw new Error(
            `records GraphJin role ${role.name} omits ${table.schema}.${table.name}.${operation}`,
          );
        }
        if (!rule.block && (!rule.columns || rule.columns.length === 0)) {
          throw new Error(
            `records GraphJin role ${role.name} has an unrestricted empty allowlist for ${table.schema}.${table.name}.${operation}`,
          );
        }
        for (const column of rule.columns ?? []) validateRecordIdentifier(column);
        for (const column of Object.keys(rule.presets ?? {})) {
          validateRecordIdentifier(column);
        }
      }
    }
  }
  if (seenRoles.size !== expectedRoles.size) {
    const missing = [...expectedRoles].filter((role) => !seenRoles.has(role));
    throw new Error(`records GraphJin config is missing roles: ${missing.join(", ")}`);
  }
}

/** Build the complete standalone records config. It intentionally has no sources key. */
export function buildRecordsGraphjinConfig(input: BuildRecordsGraphjinConfigInput): string {
  assertExhaustiveRoles(input.roles);
  const orgId = validateOrgIdForRoleQuery(input.orgId);
  if (input.jwt.secret.length < 32) {
    throw new Error("records GraphJin JWT secret must be at least 32 characters");
  }
  if (input.secretKey.length < 32) {
    throw new Error("records GraphJin cursor secret must be at least 32 characters");
  }

  const statementTimeoutMs = input.database.statementTimeoutMs ?? 5_000;
  const defaultLimit = validatePositiveInteger(input.defaultLimit ?? 100, "default row limit");
  const rate = input.rateLimit?.rate ?? 20;
  const bucket = validatePositiveInteger(input.rateLimit?.bucket ?? 40, "rate-limit bucket");
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("rate limit must be positive");
  }

  const jwt: Record<string, string> = {
    provider: "other",
    secret: input.jwt.secret,
  };
  if (input.jwt.audience) jwt.audience = input.jwt.audience;
  if (input.jwt.issuer) jwt.issuer = input.jwt.issuer;

  const connection = postgresConnectionConfig(
    input.database.connectionString,
    statementTimeoutMs,
  );
  const config = {
    app_name: "OpenNeko Records",
    mode: "prod",
    production: true,
    host_port: "0.0.0.0:8090",
    log_level: "info",
    log_format: "json",
    web_ui: false,
    enable_tracing: false,
    log_vars: false,
    auth_fail_block: true,
    reload_on_config_change: false,
    disable_allow_list: true,
    // Records queries are generated dynamically from registry metadata. In
    // GraphJin, disable_allow_list stops persistence but prodSec still rejects
    // unknown named documents; this explicit opt-out is therefore required.
    // JWT + exhaustive role-table RBAC remain the authorization boundary.
    disable_production_security: true,
    default_block: true,
    analytics_mode: true,
    default_limit: defaultLimit,
    subs_poll_duration: "5s",
    db_schema_poll_duration: "0s",
    secret_key: input.secretKey,
    rate_limiter: { rate, bucket },
    // Governed record writes may commit while GraphJin returns an empty
    // mutation selection (the update predicate can stop matching after the
    // change). GraphJin cannot derive row refs from that empty response, so
    // its default response cache is not invalidated. Records reads must never
    // serve that stale pre-write snapshot.
    caching: { disable: true },
    mcp: {
      disable: true,
      allow_mutations: false,
      allow_raw_queries: false,
    },
    auth: {
      type: "jwt",
      development: false,
      jwt,
    },
    database: {
      type: "postgres",
      connection_string: connection.connectionString,
      // GraphJin's service layer assigns DBName after parsing the URL, so this
      // duplicate is required or it clears the parsed path and Postgres falls
      // back to a database named after the user.
      dbname: connection.databaseName,
      pool_size: validatePositiveInteger(input.database.poolSize ?? 5, "database pool size"),
      max_connections: validatePositiveInteger(
        input.database.maxConnections ?? 20,
        "database max connections",
      ),
      ping_timeout: "5s",
    },
    roles_query: buildRecordsGraphjinRoleQuery(orgId),
    roles: input.roles,
  };

  return stringify(config, { lineWidth: 0, sortMapEntries: false });
}

function runGraphjin(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? VALIDATION_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GO_ENV: "development" },
      },
      (error, stdout, stderr) => {
        if (error) {
          // GraphJin diagnostics may echo connection material. Keep the
          // durable error secret-free; operators can run the pinned validator
          // directly inside the worker when detailed output is required.
          reject(new Error(`GraphJin command failed: ${binary} ${args.join(" ")}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function createRecordsGraphjinConfigValidator(options: {
  binary?: string;
  expectedVersion?: string;
  timeoutMs?: number;
} = {}): RecordsGraphjinConfigValidator {
  const binary = options.binary ?? "graphjin";
  const expectedVersion = options.expectedVersion ?? RECORDS_GRAPHJIN_VERSION;
  const timeoutMs = options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
  return async ({ configDirectory }) => {
    const version = await runGraphjin(binary, ["version"], { timeoutMs });
    if (!version.stdout.includes(`GraphJin ${expectedVersion}`)) {
      throw new Error(`records GraphJin validator must be version ${expectedVersion}`);
    }
    await runGraphjin(
      binary,
      ["serve", "test", "--json", "--path", configDirectory],
      { timeoutMs },
    );
  };
}

/**
 * Cross-process lock dedicated to the complete records config writer. This is
 * deliberately separate from customer-source GraphJin config persistence.
 */
export async function acquireRecordsGraphjinConfigLock(configFile: string): Promise<() => Promise<void>> {
  const directory = dirname(configFile);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const lockFile = join(directory, `.${basename(configFile)}.records.lock`);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockFile, "wx", LOCK_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("records GraphJin config has another projection in progress");
    }
    throw error;
  }
  try {
    await handle.writeFile(token, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  return async () => {
    const current = await readFile(lockFile, "utf8").catch(() => "");
    if (current === token) await unlink(lockFile).catch(() => undefined);
  };
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type WriteRecordsGraphjinConfigResult = {
  sha256: string;
  bytes: number;
};

/**
 * Validate a staged complete config, atomically replace the live file, then
 * invoke the caller's records-only reload boundary. Production GraphJin does
 * not file-watch configs, so a reload callback is mandatory.
 */
export async function writeRecordsGraphjinConfig(input: {
  configFile: string;
  config: BuildRecordsGraphjinConfigInput;
  reloadRecordsGraphjin: () => Promise<void>;
  validate?: RecordsGraphjinConfigValidator;
}): Promise<WriteRecordsGraphjinConfigResult> {
  if (basename(input.configFile) !== RECORDS_GRAPHJIN_CONFIG_FILENAME) {
    throw new Error(`records GraphJin config must be named ${RECORDS_GRAPHJIN_CONFIG_FILENAME}`);
  }
  if (typeof input.reloadRecordsGraphjin !== "function") {
    throw new Error("records GraphJin config requires an explicit reload callback");
  }

  const yaml = buildRecordsGraphjinConfig(input.config);
  const directory = dirname(input.configFile);
  const release = await acquireRecordsGraphjinConfigLock(input.configFile);
  const stagingDirectory = join(directory, `.records-graphjin-${randomUUID()}`);
  const stagingFile = join(stagingDirectory, RECORDS_GRAPHJIN_CONFIG_FILENAME);

  try {
    await mkdir(stagingDirectory, { mode: DIRECTORY_MODE });
    const handle = await open(stagingFile, "wx", CONFIG_MODE);
    try {
      await handle.writeFile(yaml, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    const validate = input.validate ?? createRecordsGraphjinConfigValidator();
    await validate({ configDirectory: stagingDirectory, configFile: stagingFile });
    await rename(stagingFile, input.configFile);
    await fsyncDirectory(directory);
    await input.reloadRecordsGraphjin();

    return {
      sha256: createHash("sha256").update(yaml, "utf8").digest("hex"),
      bytes: Buffer.byteLength(yaml, "utf8"),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await release();
  }
}

/** Read-only helper for boot drift audits without exposing config contents. */
export async function recordsGraphjinConfigSha256(configFile: string): Promise<string | null> {
  const metadata = await stat(configFile).catch(() => null);
  if (!metadata?.isFile() || metadata.size === 0) return null;
  const content = await readFile(configFile);
  return createHash("sha256").update(content).digest("hex");
}
