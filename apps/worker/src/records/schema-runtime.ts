import { join } from "node:path";
import type { PoolConfig } from "pg";
import type pg from "pg";
import {
  app_state,
  db,
  sql,
} from "@neko/db";
import {
  buildRecordsPoolConfig,
  runRecordsMigrations,
} from "@neko/db/records-migrate";
import {
  RECORDS_GRAPHJIN_CONFIG_FILENAME,
  RecordsGraphjinSchemaCli,
  RecordsSchemaPlanner,
  RecordsSchemaSaga,
  createRecordsGraphjinConfigValidator,
  createRecordsSchemaWorkspace,
  loadRecordsGraphjinPolicyModel,
  parseRecordAppDefinition,
  projectRecordAppDefinition,
  projectRecordsGraphjinRoles,
  recordsGraphjinCursorSecret,
  recordsGraphjinSigningSecret,
  writeRecordsGraphjinConfig,
  type RecordAppDefinition,
  type RecordSchemaChange,
  type RecordsGraphjinConfigValidator,
  type WriteRecordsGraphjinConfigResult,
} from "@neko/records";
import { RecordsDataPlaneController } from "./data-plane-control.js";

export type RecordsMetadataAppStateInput = {
  orgId: string;
  definition: RecordAppDefinition;
  registryRevision: string;
  actorUserId: string | null;
};

export type RecordsMetadataAppStateProjector = (
  input: RecordsMetadataAppStateInput,
) => Promise<void>;

export type RecordsPolicyProjector = () => Promise<WriteRecordsGraphjinConfigResult>;

function stringConfig(value: PoolConfig[keyof PoolConfig], label: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`records Postgres ${label} must be a static value`);
  }
  const result = String(value);
  if (!result) throw new Error(`records Postgres ${label} is required`);
  return result;
}

/** Build the URL consumed by the separate GraphJin process without logging it. */
export function recordsPostgresConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const config = buildRecordsPoolConfig(env);
  const host = stringConfig(config.host, "host");
  const port = stringConfig(config.port, "port");
  const user = stringConfig(config.user, "user");
  const database = stringConfig(config.database, "database");
  const password =
    typeof config.password === "string" ? config.password : "";
  const authorityHost = host.includes(":") ? `[${host}]` : host;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@${authorityHost}:${port}/${encodeURIComponent(database)}`;
}

function schemaChangeDefinition(change: RecordSchemaChange): RecordAppDefinition {
  const definition = parseRecordAppDefinition(change.artifact.detail.definition);
  if (definition.appId !== change.appId) {
    throw new Error("records schema artifact app does not match its journal row");
  }
  return definition;
}

export async function projectMetadataAppState(
  input: RecordsMetadataAppStateInput,
): Promise<void> {
  const status = input.definition.archived ? "archived" : "active";
  const config = JSON.stringify({
    registryRevision: input.registryRevision,
    label: input.definition.label,
    purpose: input.definition.purpose,
    createdByActor: input.actorUserId,
  });
  await db().execute(sql`
    insert into ${app_state}
      (org_id, app_id, status, created_by, config)
    values (
      ${input.orgId}, ${input.definition.appId}, ${status}, null,
      ${config}::jsonb
    )
    on conflict (org_id, app_id) do update
    set status = case
          when app_state.status = 'importing' and excluded.status = 'active'
            then 'importing'
          else excluded.status
        end,
        config = app_state.config || excluded.config
  `);
}

async function hasProjectionBlockers(pool: pg.Pool): Promise<boolean> {
  const result = await pool.query<{ blocked: boolean }>(`
    select exists (
      select 1 from engine.app_schema_change where phase in ('applying', 'applied')
      union all
      select 1 from engine.record_app where status = 'degraded'
    ) as blocked
  `);
  return result.rows[0]?.blocked ?? true;
}

export type RecordsSchemaRuntime = {
  planner: RecordsSchemaPlanner;
  saga: RecordsSchemaSaga;
  controller: RecordsDataPlaneController;
  projectPolicy: RecordsPolicyProjector;
  reconciliation: Awaited<ReturnType<RecordsSchemaSaga["reconcilePending"]>>;
};

/**
 * Migrate and reconcile the complete schema control plane before the worker
 * begins accepting action proposals. The returned planner and saga are then
 * registered by the worker's action layer.
 */
export async function createRecordsSchemaRuntime(options: {
  pool: pg.Pool;
  orgId: string;
  graphjinBaseUrl?: string;
  configDirectory?: string;
  graphjinBinary?: string;
  connectionString?: string;
  controller?: RecordsDataPlaneController;
  cli?: RecordsGraphjinSchemaCli;
  validateConfig?: RecordsGraphjinConfigValidator;
  projectMetadata?: RecordsMetadataAppStateProjector;
}): Promise<RecordsSchemaRuntime> {
  await runRecordsMigrations({ pool: options.pool });

  const graphjinBaseUrl =
    options.graphjinBaseUrl ??
    process.env.OPENNEKO_RECORDS_GRAPHJIN_URL ??
    "http://127.0.0.1:8090";
  const configDirectory =
    options.configDirectory ??
    process.env.OPENNEKO_RECORDS_GRAPHJIN_CONFIG_DIR ??
    "/tmp/openneko-records-graphjin";
  const configFile = join(configDirectory, RECORDS_GRAPHJIN_CONFIG_FILENAME);
  const binary =
    options.graphjinBinary ??
    process.env.OPENNEKO_RECORDS_GRAPHJIN_BINARY ??
    "graphjin";
  const controller =
    options.controller ??
    new RecordsDataPlaneController({
      configDirectory,
      baseUrl: graphjinBaseUrl,
    });
  const validateConfig =
    options.validateConfig ?? createRecordsGraphjinConfigValidator({ binary });
  const connectionString =
    options.connectionString ?? recordsPostgresConnectionString();

  const projectPolicy: RecordsPolicyProjector = async () => {
    const model = await loadRecordsGraphjinPolicyModel(options.pool, options.orgId);
    return writeRecordsGraphjinConfig({
      configFile,
      config: {
        orgId: options.orgId,
        roles: projectRecordsGraphjinRoles(model),
        database: { connectionString },
        jwt: { secret: recordsGraphjinSigningSecret(options.orgId) },
        secretKey: recordsGraphjinCursorSecret(options.orgId),
      },
      validate: validateConfig,
      reloadRecordsGraphjin: () => controller.requestReload(),
    });
  };

  const projectMetadata = options.projectMetadata ?? projectMetadataAppState;
  const cli = options.cli ?? new RecordsGraphjinSchemaCli({ binary });
  const saga = new RecordsSchemaSaga({
    pool: options.pool,
    cli,
    workspace: createRecordsSchemaWorkspace(configFile),
    setDataPlaneReady: (ready, reason) => controller.setReady(ready, reason),
    project: async (change) => {
      const definition = schemaChangeDefinition(change);
      const registryRevision = await projectRecordAppDefinition(options.pool, {
        orgId: change.orgId,
        definition,
        desiredRevision: change.desiredRevision,
      });
      await projectPolicy();
      await projectMetadata({
        orgId: change.orgId,
        definition,
        registryRevision,
        actorUserId: change.artifact.actorUserId,
      });
    },
  });
  const planner = new RecordsSchemaPlanner({ pool: options.pool, saga });

  await controller.setReady(false, "records worker boot reconciliation");
  await projectPolicy();
  const reconciliation = await saga.reconcilePending();
  if (reconciliation.failed.length > 0 || (await hasProjectionBlockers(options.pool))) {
    await controller.setReady(
      false,
      "records schema reconciliation remains incomplete",
    );
  } else {
    await controller.setReady(true, "records schema boot reconciliation complete");
  }

  return { planner, saga, controller, projectPolicy, reconciliation };
}
