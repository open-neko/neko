import "server-only";

import pg from "pg";
import {
  and,
  app_user,
  app_state,
  buildRecordsPoolConfig,
  db,
  eq,
  inArray,
} from "@neko/db";
import {
  buildRecordDetailQuery,
  buildRecordListQuery,
  mintRecordsGraphjinToken,
  RecordRegistry,
  recordsGraphjinSigningSecret,
  RecordsGraphjinClient,
  syncRecordsActor,
  validateRecordIdentifier,
  type AppRegistrySnapshot,
  type JsonObject,
  type RecordListFilter,
  type RecordObjectView,
  type RecordViewerRole,
} from "@neko/records";
import { getCurrentActor } from "@/lib/actor";

const RECORDS_GRAPHJIN_URL =
  process.env.OPENNEKO_RECORDS_GRAPHJIN_URL ?? "http://127.0.0.1:8090";

type RecordsRuntime = {
  pool: pg.Pool;
  registry: RecordRegistry;
  graphjin: RecordsGraphjinClient;
};

const runtimeGlobal = globalThis as typeof globalThis & {
  __opennekoWebRecordsRuntime?: RecordsRuntime;
};

function createRuntime(): RecordsRuntime {
  const pool = new pg.Pool({
    ...buildRecordsPoolConfig(),
    application_name: "openneko-web-records",
  });
  return {
    pool,
    registry: new RecordRegistry(pool),
    graphjin: new RecordsGraphjinClient({ baseUrl: RECORDS_GRAPHJIN_URL }),
  };
}

function recordsRuntime(): RecordsRuntime {
  const existing = runtimeGlobal.__opennekoWebRecordsRuntime;
  if (existing) return existing;
  const created = createRuntime();
  runtimeGlobal.__opennekoWebRecordsRuntime = created;
  return created;
}

export async function resetWebRecordsRuntimeForTesting(): Promise<void> {
  const current = runtimeGlobal.__opennekoWebRecordsRuntime;
  runtimeGlobal.__opennekoWebRecordsRuntime = undefined;
  if (current) await current.pool.end();
}

export type RecordAppNavObject = {
  apiName: string;
  label: string;
  pluralLabel: string;
  recordCount: string | null;
  custom: boolean;
  canCreate: boolean;
};

export type RecordAppNavItem = {
  appId: string;
  label: string;
  purpose: string | null;
  objects: RecordAppNavObject[];
};

export type RecordAppShell = {
  snapshot: AppRegistrySnapshot;
  metadataStatus: string;
  availability: "active" | "degraded";
  degradedReason: string | null;
  config: JsonObject;
};

export class RecordAppRouteError extends Error {
  readonly code = "records_app_route_unavailable";

  constructor(
    message: string,
    readonly status: 404 | 409 | 503,
  ) {
    super(message);
    this.name = "RecordAppRouteError";
  }
}

function viewerPermission(
  snapshot: AppRegistrySnapshot,
  role: RecordViewerRole,
  objectApiName: string,
) {
  return snapshot.permissions.find(
    (permission) =>
      permission.role === role &&
      permission.objectApiName === objectApiName &&
      permission.canRead,
  );
}

async function metadataAppState(orgId: string, appId: string): Promise<{
  status: string;
  config: JsonObject;
} | null> {
  const rows = await db()
    .select({ status: app_state.status, config: app_state.config })
    .from(app_state)
    .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, appId)))
    .limit(1);
  const row = rows[0];
  return row ? { status: row.status, config: row.config } : null;
}

function canonicalAppId(value: string): string {
  try {
    return validateRecordIdentifier(value);
  } catch {
    throw new RecordAppRouteError("record app was not found", 404);
  }
}

export async function loadRecordAppShell(
  orgId: string,
  appId: string,
): Promise<RecordAppShell> {
  const canonical = canonicalAppId(appId);
  const [state, snapshot] = await Promise.all([
    metadataAppState(orgId, canonical),
    recordsRuntime().registry.loadApp(orgId, canonical),
  ]);
  if (!state || !snapshot || snapshot.app.status === "archived") {
    throw new RecordAppRouteError("record app was not found", 404);
  }
  const active = state.status === "active" && snapshot.app.status === "active";
  const degraded = state.status === "degraded" || snapshot.app.status === "degraded";
  if (!active && !degraded) {
    throw new RecordAppRouteError("record app is not available yet", 409);
  }
  return {
    snapshot,
    metadataStatus: state.status,
    availability: active ? "active" : "degraded",
    degradedReason: active
      ? null
      : state.status !== snapshot.app.status
        ? `Metadata reports ${state.status}; the records registry reports ${snapshot.app.status}.`
        : "The records data plane is degraded and reads are paused.",
    config: state.config,
  };
}

export async function listRecordAppsForViewer(input: {
  orgId: string;
  role: RecordViewerRole;
}): Promise<RecordAppNavItem[]> {
  const states = await db()
    .select({ appId: app_state.app_id })
    .from(app_state)
    .where(and(eq(app_state.org_id, input.orgId), eq(app_state.status, "active")));
  const activeMetadata = new Set(states.map((row) => row.appId));
  const apps = (await recordsRuntime().registry.listApps(input.orgId)).filter(
    (app) => app.status === "active" && activeMetadata.has(app.appId),
  );
  const snapshots = await Promise.all(
    apps.map((app) => recordsRuntime().registry.loadApp(input.orgId, app.appId)),
  );
  return snapshots.flatMap((snapshot): RecordAppNavItem[] => {
    if (!snapshot) return [];
    const objects = snapshot.objects.flatMap((object): RecordAppNavObject[] => {
      if (object.archivedAt !== null) return [];
      const permission = viewerPermission(snapshot, input.role, object.apiName);
      if (!permission) return [];
      return [
        {
          apiName: object.apiName,
          label: object.label,
          pluralLabel: object.pluralLabel,
          recordCount: object.recordCount,
          custom: object.custom,
          canCreate: permission.canCreate,
        },
      ];
    });
    return objects.length > 0
      ? [
          {
            appId: snapshot.app.appId,
            label: snapshot.app.label,
            purpose: snapshot.app.purpose,
            objects,
          },
        ]
      : [];
  });
}

export async function getRecordAppNav(input: {
  orgId: string;
  appId: string;
  role: RecordViewerRole;
}): Promise<RecordAppNavItem> {
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  if (shell.availability !== "active") {
    throw new RecordAppRouteError(shell.degradedReason ?? "record app is degraded", 503);
  }
  const objects = shell.snapshot.objects.flatMap((object): RecordAppNavObject[] => {
    if (object.archivedAt !== null) return [];
    const permission = viewerPermission(shell.snapshot, input.role, object.apiName);
    if (!permission) return [];
    return [
      {
        apiName: object.apiName,
        label: object.label,
        pluralLabel: object.pluralLabel,
        recordCount: object.recordCount,
        custom: object.custom,
        canCreate: permission.canCreate,
      },
    ];
  });
  if (objects.length === 0) throw new RecordAppRouteError("record app was not found", 404);
  return {
    appId: shell.snapshot.app.appId,
    label: shell.snapshot.app.label,
    purpose: shell.snapshot.app.purpose,
    objects,
  };
}

async function recordsViewer(orgId: string): Promise<{
  role: RecordViewerRole;
  userId: string;
  token: string;
}> {
  const actor = await getCurrentActor();
  const role: RecordViewerRole = actor.role === "member" ? "member" : "admin";
  const userId = actor.userId ?? `urn:openneko:solo-admin:${orgId}`;
  await syncRecordsActor(recordsRuntime().pool, { orgId, userId, role });
  return {
    role,
    userId,
    token: mintRecordsGraphjinToken({
      secret: recordsGraphjinSigningSecret(orgId),
      orgId,
      userId,
      role,
    }),
  };
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (row): row is Record<string, unknown> =>
          typeof row === "object" && row !== null && !Array.isArray(row),
      )
    : [];
}

function totalFrom(value: unknown): number {
  const raw = rowsFrom(value)[0]?.count_id;
  const total = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "0"), 10);
  return Number.isSafeInteger(total) && total >= 0 ? total : 0;
}

export type RecordListResult = {
  rows: Array<Record<string, unknown>>;
  cursor: string | null;
  total: number;
  view: RecordObjectView;
  app: AppRegistrySnapshot["app"];
  owners: Record<string, RecordOwnerIdentity>;
};

export type RecordOwnerIdentity = {
  userId: string;
  label: string;
  email: string | null;
  status: "linked" | "unlinked" | "conflict" | "ignored";
};

async function resolveOwnerIdentities(input: {
  orgId: string;
  appId: string;
  rows: Array<Record<string, unknown>>;
}): Promise<Record<string, RecordOwnerIdentity>> {
  const ownerIds = [
    ...new Set(
      input.rows
        .map((row) => row.owner_user_id)
        .filter((value): value is string => typeof value === "string" && Boolean(value)),
    ),
  ];
  if (ownerIds.length === 0) return {};
  const identities = await recordsRuntime().pool.query<{
    source_user_id: string;
    source_email: string;
    source_name: string | null;
    app_user_id: string | null;
    status: "linked" | "unlinked" | "conflict" | "ignored";
  }>(
    `select source_user_id, source_email, source_name, app_user_id, status
     from engine.identity_map
     where org_id = $1 and app_id = $2
       and (source_user_id = any($3::text[]) or app_user_id = any($3::text[]))`,
    [input.orgId, input.appId, ownerIds],
  );
  const metadataIds = [
    ...new Set([
      ...ownerIds,
      ...identities.rows
        .map((identity) => identity.app_user_id)
        .filter((value): value is string => value !== null),
    ]),
  ];
  const users = await db()
    .select({ id: app_user.id, name: app_user.name, email: app_user.email })
    .from(app_user)
    .where(and(eq(app_user.org_id, input.orgId), inArray(app_user.id, metadataIds)));
  const usersById = new Map(users.map((user) => [user.id, user]));
  return Object.fromEntries(
    ownerIds.map((ownerId): [string, RecordOwnerIdentity] => {
      const identity = identities.rows.find(
        (candidate) =>
          candidate.source_user_id === ownerId || candidate.app_user_id === ownerId,
      );
      const user = usersById.get(identity?.app_user_id ?? ownerId);
      return [
        ownerId,
        {
          userId: identity?.app_user_id ?? ownerId,
          label:
            user?.name ??
            identity?.source_name ??
            user?.email ??
            identity?.source_email ??
            ownerId,
          email: user?.email ?? identity?.source_email ?? null,
          status: identity?.status ?? (user ? "linked" : "unlinked"),
        },
      ];
    }),
  );
}

export async function readRecordList(input: {
  orgId: string;
  appId: string;
  objectApiName: string;
  first?: number;
  after?: string | null;
  sort?: { field: string; direction: "asc" | "desc" };
  search?: string | null;
  filters?: RecordListFilter[];
  myRecords?: boolean;
}): Promise<RecordListResult> {
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  if (shell.availability !== "active") {
    throw new RecordAppRouteError(shell.degradedReason ?? "record app is degraded", 503);
  }
  const viewer = await recordsViewer(input.orgId);
  const generated = buildRecordListQuery({
    snapshot: shell.snapshot,
    objectApiName: input.objectApiName,
    role: viewer.role,
    userId: viewer.userId,
    first: input.first,
    after: input.after,
    sort: input.sort,
    search: input.search,
    filters: input.filters,
    myRecords: input.myRecords,
  });
  const data = await recordsRuntime().graphjin.execute<Record<string, unknown>>({
    operationName: generated.operationName,
    query: generated.query,
    variables: generated.variables,
    token: viewer.token,
  });
  const rows = rowsFrom(data[generated.resultField]);
  return {
    rows,
    cursor:
      typeof data[generated.cursorField] === "string"
        ? String(data[generated.cursorField])
        : null,
    total: totalFrom(data[generated.totalField]),
    view: generated.view,
    app: shell.snapshot.app,
    owners: await resolveOwnerIdentities({
      orgId: input.orgId,
      appId: shell.snapshot.app.appId,
      rows,
    }),
  };
}

export type RecordDetailResult = {
  row: Record<string, unknown> | null;
  view: RecordObjectView;
  app: AppRegistrySnapshot["app"];
  owners: Record<string, RecordOwnerIdentity>;
};

export async function readRecordDetail(input: {
  orgId: string;
  appId: string;
  objectApiName: string;
  recordId: string;
  allFields?: boolean;
}): Promise<RecordDetailResult> {
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  if (shell.availability !== "active") {
    throw new RecordAppRouteError(shell.degradedReason ?? "record app is degraded", 503);
  }
  const viewer = await recordsViewer(input.orgId);
  const generated = buildRecordDetailQuery({
    snapshot: shell.snapshot,
    objectApiName: input.objectApiName,
    role: viewer.role,
    recordId: input.recordId,
    allFields: input.allFields,
  });
  const data = await recordsRuntime().graphjin.execute<Record<string, unknown>>({
    operationName: generated.operationName,
    query: generated.query,
    variables: generated.variables,
    token: viewer.token,
  });
  const row = rowsFrom(data[generated.resultField])[0] ?? null;
  return {
    row,
    view: generated.view,
    app: shell.snapshot.app,
    owners: await resolveOwnerIdentities({
      orgId: input.orgId,
      appId: shell.snapshot.app.appId,
      rows: row ? [row] : [],
    }),
  };
}

export async function getRecordSubstrateStatus(input: {
  orgId: string;
  appId: string;
}): Promise<{
  availability: "active" | "degraded";
  reason: string | null;
  config: JsonObject;
  unlinkedIdentities: number;
  latestSync: { watermark: unknown; updatedAt: string } | null;
}> {
  const shell = await loadRecordAppShell(input.orgId, input.appId);
  const [identity, sync] = await Promise.all([
    recordsRuntime().pool.query<{ count: number }>(
      `select count(*)::int as count from engine.identity_map
       where org_id = $1 and app_id = $2 and status in ('unlinked', 'conflict')`,
      [input.orgId, shell.snapshot.app.appId],
    ),
    recordsRuntime().pool.query<{ watermark: unknown; updated_at: Date }>(
      `select watermark, updated_at from engine.sync_cursor
       where org_id = $1 and app_id = $2
       order by updated_at desc limit 1`,
      [input.orgId, shell.snapshot.app.appId],
    ),
  ]);
  const latest = sync.rows[0];
  return {
    availability: shell.availability,
    reason: shell.degradedReason,
    config: shell.config,
    unlinkedIdentities: identity.rows[0]?.count ?? 0,
    latestSync: latest
      ? { watermark: latest.watermark, updatedAt: latest.updated_at.toISOString() }
      : null,
  };
}
