import { enqueue, QUEUE } from "@neko/db/jobs";
import {
  createActionRequest,
  listAllPolicies,
  listEnabledPolicies,
  upsertActionPolicyByName,
  type ActionPolicyRecord,
  type CreateActionPolicyInput,
  type UpsertActionPolicyResult,
} from "../workflows/action-store";
import { evaluateActionPolicy } from "../workflows/policy-engine";
import {
  saveWorkflowWithTrigger,
  type SaveWorkflowWithTriggerResult,
} from "../workflows/save-workflow-with-trigger";
import {
  deleteWorkflow,
  emitWorkflowOutput,
  listSubscriptionsByWorkflow,
  listWorkflows,
  type SaveWorkflowInput,
  type WorkflowRecord,
  type WorkflowOutputInput,
  type WorkflowOutputRecord,
} from "../workflows/store";
import { notifyWorkflowOutputDeliveryHook } from "../workflows/output-delivery";
import { rememberWorkMemory, searchWorkMemoryByContext } from "./memory";
import type {
  GraphjinAgentResponse,
  GraphjinAgentStatus,
} from "../graphjin/agent";

type PolicyRequestSubject = Parameters<typeof evaluateActionPolicy>[0];
type PolicyDecision = ReturnType<typeof evaluateActionPolicy>;
type CreateActionRequestInput = Parameters<typeof createActionRequest>[0];
type RememberWorkMemoryInput = Parameters<typeof rememberWorkMemory>[0];
type WorkMemorySearchArgs = Parameters<typeof searchWorkMemoryByContext>[0];
type WorkMemorySearchResult = Awaited<
  ReturnType<typeof searchWorkMemoryByContext>
>[number];

/**
 * JSON-safe view of a control-plane result: what a value looks like after a
 * broker HTTP hop (Dates become ISO strings, undefined drops). The in-process
 * impl applies the same transform so both paths return identical shapes.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Wire<U>>
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

function toWire<T>(value: T): Wire<T> {
  return JSON.parse(JSON.stringify(value ?? null)) as Wire<T>;
}

async function requireSourceConfigAccess(input: {
  orgId: string;
  runId?: string | null;
  actorRole?: string | null;
}): Promise<
  { ok: true; userId: string | null } | { ok: false; error: string }
> {
  const {
    and,
    app_user,
    db,
    eq,
    getGraphjinConfigSettingsForOrg,
    work_run,
  } = await import("@neko/db");
  const settings = await getGraphjinConfigSettingsForOrg(input.orgId);
  if (!settings.sourceConfigEnabled) {
    return {
      ok: false,
      error: "GraphJin config capability is disabled.",
    };
  }

  let role: string | null = null;
  let userId: string | null = null;
  if (input.runId) {
    const [run] = await db()
      .select({
        orgId: work_run.org_id,
        userId: work_run.actor_user_id,
        snapshotRole: work_run.actor_role,
      })
      .from(work_run)
      .where(eq(work_run.id, input.runId))
      .limit(1);
    if (!run || run.orgId !== input.orgId) {
      return { ok: false, error: "GraphJin config run is not available." };
    }
    if (run.userId) {
      userId = run.userId;
      const [user] = await db()
        .select({ role: app_user.role, disabledAt: app_user.disabled_at })
        .from(app_user)
        .where(
          and(
            eq(app_user.id, run.userId),
            eq(app_user.org_id, input.orgId),
          ),
        )
        .limit(1);
      role = user && !user.disabledAt ? user.role : null;
    } else {
      // Null-user admin runs are valid only in the solo profile. In a
      // multi-user org, a deleted/detached admin must not inherit the solo
      // profile's authority from the role snapshot.
      const [anyUser] = await db()
        .select({ id: app_user.id })
        .from(app_user)
        .where(eq(app_user.org_id, input.orgId))
        .limit(1);
      role = anyUser ? null : run.snapshotRole;
    }
  } else {
    role = input.actorRole ?? null;
  }
  if (role !== "admin") {
    return {
      ok: false,
      error: "GraphJin config tools are admin-only.",
    };
  }

  return { ok: true, userId };
}

export type SourceConfigAgentResult = {
  denied?: boolean;
  error?: string;
  source?: { id: string; name: string; host: string | null };
  agentStatus?: GraphjinAgentStatus;
  response?: GraphjinAgentResponse;
};

export type SourceConfigPreviewResult = {
  denied?: boolean;
  error?: string;
  source?: { id: string; name: string; host: string | null };
  preview?: {
    valid: boolean;
    patchHash: string;
    catalogRevision: string;
    expiresAt: string | null;
    scope: string | null;
    reloadMode: string | null;
    changes: unknown;
    findings: unknown;
    errors: unknown;
  };
};

export type WorkflowListEntry = Wire<WorkflowRecord> & {
  /** Enabled source_change trigger filter, if any. */
  when: Record<string, unknown> | null;
};

/**
 * The narrow control-plane surface an agent turn touches: policy eval,
 * action-request create + enqueue, the two memory ops, and the builder
 * tools' workflow/rule saves and lists. In-process today (direct DB/pg-boss).
 * The agent-sandbox path (Phase 2) injects an HTTP impl backed by the broker,
 * so the sandbox never holds DB creds or the pg-boss connection — the worker
 * stays the only gateway to those.
 */
export interface AgentControlPlane {
  evaluateActionPolicy(
    input: { orgId: string } & PolicyRequestSubject,
  ): Promise<PolicyDecision>;
  createActionRequest(input: CreateActionRequestInput): Promise<{ id: string }>;
  enqueueActionExecute(input: {
    orgId: string;
    actionRequestId: string;
  }): Promise<void>;
  rememberWorkMemory(input: RememberWorkMemoryInput): Promise<{ id: string }>;
  searchWorkMemoryByContext(
    args: WorkMemorySearchArgs,
  ): Promise<WorkMemorySearchResult[]>;
  saveWorkflowWithTrigger(
    input: SaveWorkflowInput,
  ): Promise<Wire<SaveWorkflowWithTriggerResult>>;
  emitWorkflowOutput(
    input: WorkflowOutputInput,
  ): Promise<Wire<WorkflowOutputRecord>>;
  listWorkflowsWithTriggers(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ total: number; workflows: WorkflowListEntry[] }>;
  /**
   * Hard-delete a workflow and its dependents (triggers, runs, outputs,
   * proposed actions cascade via FK). Org-scoped: `found: false` when the id
   * doesn't belong to the org. Mirrors `DELETE /api/workflows/[id]`.
   */
  deleteWorkflow(input: {
    orgId: string;
    workflowId: string;
  }): Promise<{ found: boolean; name: string | null }>;
  upsertActionPolicyByName(
    input: CreateActionPolicyInput,
  ): Promise<Wire<UpsertActionPolicyResult>>;
  listActionPolicies(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ total: number; policies: Array<Wire<ActionPolicyRecord>> }>;
  /** ADM3: installed plugins (manifest) + marketplace catalog. */
  listPlugins(input: { orgId: string }): Promise<PluginCatalog>;
  /** ADM1: the org's users (id, email, role, disabled). */
  listUsers(input: { orgId: string }): Promise<{
    users: Array<{
      id: string;
      email: string;
      name: string | null;
      role: string;
      disabledAt: string | null;
      lastLoginAt: string | null;
    }>;
  }>;
  /**
   * ADM2: the org's data-source registry. Connection URLs are reduced to
   * hostnames — credentials never enter model context.
   */
  listDataSources(input: { orgId: string }): Promise<{
    sources: Array<{
      id: string;
      name: string;
      label: string | null;
      kind: string;
      authMode: string;
      isDefault: boolean;
      enabled: boolean;
      host: string | null;
      hasMcp: boolean;
    }>;
  }>;
  /**
   * OL5: the live "unified source graph" of the CUSTOMER GraphJin —
   * databases, capabilities, and namespaces discovered from gj_catalog
   * under a minted service token. Read-only; never touches the OpenNeko
   * internal GraphJin. `reachable: false` with `error` when the engine
   * is down or not in sources mode.
   */
  describeSourceGraph(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
  }): Promise<{
    reachable: boolean;
    denied?: boolean;
    error?: string;
    sourceName?: string;
    host?: string | null;
    databases?: Array<{ id: string; name: string; summary: string }>;
    capabilities?: Array<{ id: string; name: string; summary: string }>;
    namespaces?: Array<{ id: string; name: string; summary: string }>;
  }>;
  /**
   * OL5: the NAMES of stored data-source connection secrets (never the
   * values). The agent references these as `secretRef` when proposing a
   * source registration; the worker resolves the value at apply.
   */
  listSourceSecretNames(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
  }): Promise<{
    denied?: boolean;
    error?: string;
    names: Array<{ name: string; description: string | null; updatedAt: string }>;
  }>;
  /**
   * Ask the selected customer GraphJin's built-in server agent to inspect or
   * explain its configuration. The host verifies the agent is globally
   * read-only before forwarding an instruction, and authenticates with a
   * short-lived admin JWT that never enters the sandbox.
   */
  askSourceConfigAgent(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
    dataSourceId?: string;
    instruction: string;
    maxSteps?: number;
  }): Promise<SourceConfigAgentResult>;
  /** Validate the exact allowlisted patch before an approval is created. */
  previewSourceConfigChange(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
    dataSourceId?: string;
    payload: Record<string, unknown>;
  }): Promise<SourceConfigPreviewResult>;
  /**
   * ADM4: the audit trail, for ADMIN runs only — the requesting run's
   * K1 actor is checked server-side (the sandbox is never trusted to
   * assert its own role). Member/service runs get denied: true.
   */
  listAuditTrail(input: { orgId: string; runId?: string | null; limit?: number }): Promise<{
    denied?: boolean;
    requests?: Array<{
      id: string;
      kind: string;
      target: string | null;
      status: string;
      scope: string;
      summary: string | null;
      actorUserId: string | null;
      actorRole: string | null;
      actorBackend: string | null;
      createdAt: string;
    }>;
    alerts?: Array<{
      id: string;
      kind: string;
      subject: string;
      observed: number;
      threshold: number;
      windowSeconds: number;
      acknowledgedAt: string | null;
      createdAt: string;
    }>;
    gatewaySummary?: Array<{
      runId: string | null;
      backend: string | null;
      actorRole: string | null;
      calls: number;
    }>;
  }>;
  /** ADM5: channel workspaces (CH2) + identities (CH3) for chat-first channel management. */
  listChannels(input: { orgId: string }): Promise<{
    workspaces: Array<{
      channelPlugin: string;
      workspaceId: string;
      createdAt: string | null;
    }>;
    identities: Array<{
      id: string;
      channelPlugin: string;
      workspaceId: string;
      channelUserId: string;
      displayName: string | null;
      email: string | null;
      status: string;
      appUserId: string | null;
      firstSeenAt: string | null;
      verifiedAt: string | null;
    }>;
  }>;
}

export type PluginCatalog = {
  installed: Array<{
    name: string;
    version: string;
    source: string;
    network: string[];
    installedAt: string | null;
  }>;
  available: Array<{
    name: string;
    title: string;
    description: string;
    version: string;
  }>;
  marketplaceError?: string;
};

export class InProcessControlPlane implements AgentControlPlane {
  async evaluateActionPolicy(
    input: { orgId: string } & PolicyRequestSubject,
  ): Promise<PolicyDecision> {
    const { orgId, ...subject } = input;
    const policies = await listEnabledPolicies(orgId);
    return evaluateActionPolicy(subject, policies);
  }

  async createActionRequest(
    input: CreateActionRequestInput,
  ): Promise<{ id: string }> {
    if (input.kind === "source_config_admin") {
      const gate = await requireSourceConfigAccess({
        orgId: input.orgId,
        runId: input.workRunId ?? null,
        actorRole: input.actorRole ?? null,
      });
      if (!gate.ok) {
        throw new Error(`source_config_admin: ${gate.error}`);
      }
    }
    const request = await createActionRequest(input);
    return { id: request.id };
  }

  async enqueueActionExecute(input: {
    orgId: string;
    actionRequestId: string;
  }): Promise<void> {
    await enqueue(QUEUE.ACTION_EXECUTE, input);
  }

  async rememberWorkMemory(
    input: RememberWorkMemoryInput,
  ): Promise<{ id: string }> {
    const memory = await rememberWorkMemory(input);
    return { id: memory.id };
  }

  async searchWorkMemoryByContext(
    args: WorkMemorySearchArgs,
  ): Promise<WorkMemorySearchResult[]> {
    return searchWorkMemoryByContext(args);
  }

  async saveWorkflowWithTrigger(
    input: SaveWorkflowInput,
  ): Promise<Wire<SaveWorkflowWithTriggerResult>> {
    return toWire(await saveWorkflowWithTrigger(input));
  }

  async emitWorkflowOutput(
    input: WorkflowOutputInput,
  ): Promise<Wire<WorkflowOutputRecord>> {
    const output = await emitWorkflowOutput(input);
    notifyWorkflowOutputDeliveryHook(input.orgId, output);
    return toWire(output);
  }

  async listWorkflowsWithTriggers(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ total: number; workflows: WorkflowListEntry[] }> {
    const all = await listWorkflows(input.orgId);
    const slice = all.slice(0, input.limit ?? 50);
    const triggers = await Promise.all(
      slice.map((w) => listSubscriptionsByWorkflow(input.orgId, w.id)),
    );
    return {
      total: all.length,
      workflows: slice.map((w, i) => {
        const dataTrigger = triggers[i].find(
          (s) => s.sourceKind === "source_change" && s.enabled,
        );
        return { ...toWire(w), when: dataTrigger ? dataTrigger.filter : null };
      }),
    };
  }

  async deleteWorkflow(input: {
    orgId: string;
    workflowId: string;
  }): Promise<{ found: boolean; name: string | null }> {
    const deleted = await deleteWorkflow(input.orgId, input.workflowId);
    return { found: deleted !== null, name: deleted?.name ?? null };
  }

  async upsertActionPolicyByName(
    input: CreateActionPolicyInput,
  ): Promise<Wire<UpsertActionPolicyResult>> {
    return toWire(await upsertActionPolicyByName(input));
  }

  async listActionPolicies(input: {
    orgId: string;
    limit?: number;
  }): Promise<{ total: number; policies: Array<Wire<ActionPolicyRecord>> }> {
    const all = await listAllPolicies(input.orgId);
    return {
      total: all.length,
      policies: all.slice(0, input.limit ?? 50).map((p) => toWire(p)),
    };
  }

  async listPlugins(_input: { orgId: string }): Promise<PluginCatalog> {
    const {
      readManifest,
      createMarketplaceClient,
      OFFICIAL_MARKETPLACE_URL,
    } = await import("@open-neko/plugin-install");
    const manifest = await readManifest(process.cwd()).catch(() => null);
    const installed = (manifest?.plugins ?? []).map((p) => ({
      name: p.name,
      version: p.version,
      source: p.installSource ?? "marketplace",
      network: p.permissions?.network ?? [],
      installedAt: p.installedAt ?? null,
    }));
    let available: PluginCatalog["available"] = [];
    let marketplaceError: string | undefined;
    try {
      const marketplace = await createMarketplaceClient().fetch(
        OFFICIAL_MARKETPLACE_URL,
      );
      available = (marketplace.plugins ?? []).map((p) => {
        const latest = p.versions.find((v) => !v.yanked) ?? p.versions[0];
        return {
          name: p.name,
          title: p.title || p.name,
          description: p.description ?? "",
          version: latest?.version ?? "unknown",
        };
      });
    } catch (err) {
      marketplaceError = err instanceof Error ? err.message : String(err);
    }
    return {
      installed,
      available,
      ...(marketplaceError ? { marketplaceError } : {}),
    };
  }

  async listUsers(input: { orgId: string }) {
    const { app_user, db, eq } = await import("@neko/db");
    const rows = await db()
      .select({
        id: app_user.id,
        email: app_user.email,
        name: app_user.name,
        role: app_user.role,
        disabledAt: app_user.disabled_at,
        lastLoginAt: app_user.last_login_at,
      })
      .from(app_user)
      .where(eq(app_user.org_id, input.orgId));
    return {
      users: rows.map((r) => ({
        ...r,
        disabledAt: r.disabledAt?.toISOString() ?? null,
        lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
      })),
    };
  }

  async listDataSources(input: { orgId: string }) {
    const { data_source, db, eq } = await import("@neko/db");
    const rows = await db()
      .select()
      .from(data_source)
      .where(eq(data_source.org_id, input.orgId));
    return {
      sources: rows.map((r) => ({
        id: r.id,
        name: r.name,
        label: r.label,
        kind: r.kind,
        authMode: r.auth_mode,
        isDefault: r.is_default,
        enabled: r.enabled,
        host: hostnameOf(r.graphql_url),
        hasMcp: Boolean(r.mcp_url),
      })),
    };
  }

  async describeSourceGraph(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
  }) {
    const gate = await requireSourceConfigAccess(input);
    if (!gate.ok) {
      return { reachable: false, denied: true, error: gate.error };
    }

    const { data_source, db, desc, eq } = await import("@neko/db");
    const [src] = await db()
      .select({ name: data_source.name, graphqlUrl: data_source.graphql_url })
      .from(data_source)
      .where(eq(data_source.org_id, input.orgId))
      .orderBy(desc(data_source.is_default), data_source.created_at)
      .limit(1);
    if (!src?.graphqlUrl) {
      return { reachable: false, error: "no data source configured" };
    }
    const { mintGraphjinToken } = await import("../graphjin/token");
    const { graphjinQuery } = await import("../graphjin/client");
    const token = mintGraphjinToken({
      orgId: input.orgId,
      userId: null,
      role: "service",
    });
    const kinds = ["database", "capability", "namespace"] as const;
    type Row = { id: string; name: string; summary: string };
    const buckets: Record<string, Row[]> = {
      database: [],
      capability: [],
      namespace: [],
    };
    try {
      for (const kind of kinds) {
        const res = await graphjinQuery<{ gj_catalog?: Row[] }>({
          baseUrl: src.graphqlUrl,
          query: `query { gj_catalog(where: { kind: { eq: "${kind}" } }, limit: 100) { id name summary } }`,
          headers: { authorization: `Bearer ${token}` },
        });
        if (res.errors?.length) {
          return {
            reachable: false,
            error: res.errors.map((e) => e.message).join("; ").slice(0, 300),
          };
        }
        buckets[kind] = Array.isArray(res.data?.gj_catalog)
          ? res.data.gj_catalog
          : [];
      }
    } catch (err) {
      return {
        reachable: false,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      };
    }
    return {
      reachable: true,
      sourceName: src.name,
      host: hostnameOf(src.graphqlUrl),
      databases: buckets.database,
      capabilities: buckets.capability,
      namespaces: buckets.namespace,
    };
  }

  async listSourceSecretNames(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
  }) {
    const gate = await requireSourceConfigAccess(input);
    if (!gate.ok) {
      return { denied: true, error: gate.error, names: [] };
    }

    const { data_source_secret, db, desc, eq } = await import("@neko/db");
    const rows = await db()
      .select({
        name: data_source_secret.name,
        description: data_source_secret.description,
        updatedAt: data_source_secret.updated_at,
      })
      .from(data_source_secret)
      .where(eq(data_source_secret.org_id, input.orgId))
      .orderBy(desc(data_source_secret.updated_at));
    return {
      names: rows.map((r) => ({
        name: r.name,
        description: r.description,
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  async askSourceConfigAgent(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
    dataSourceId?: string;
    instruction: string;
    maxSteps?: number;
  }): Promise<SourceConfigAgentResult> {
    const gate = await requireSourceConfigAccess(input);
    if (!gate.ok) {
      return { denied: true, error: gate.error };
    }
    const instruction = input.instruction.trim();
    if (!instruction || instruction.length > 8_000) {
      return {
        error: "instruction must contain between 1 and 8,000 characters",
      };
    }

    const { and, data_source, db, eq } = await import("@neko/db");
    const rows = await db()
      .select({
        id: data_source.id,
        name: data_source.name,
        kind: data_source.kind,
        graphqlUrl: data_source.graphql_url,
      })
      .from(data_source)
      .where(
        and(
          eq(data_source.org_id, input.orgId),
          eq(data_source.enabled, true),
          ...(input.dataSourceId
            ? [eq(data_source.id, input.dataSourceId)]
            : []),
        ),
      )
      .limit(input.dataSourceId ? 1 : 3);
    if (rows.length === 0) {
      return { error: "no enabled customer GraphJin data source was found" };
    }
    if (!input.dataSourceId && rows.length > 1) {
      return {
        error:
          "multiple enabled data sources exist; choose a dataSourceId with list_data_sources before asking the configuration agent",
      };
    }
    const src = rows[0]!;
    if (src.kind !== "graphjin") {
      return { error: "the selected data source is not a GraphJin server" };
    }
    if (isInternalGraphjinURL(src.graphqlUrl)) {
      return {
        denied: true,
        error: "refusing to inspect the OpenNeko internal GraphJin",
      };
    }

    const { askGraphjinAgent, getGraphjinAgentStatus } = await import(
      "../graphjin/agent"
    );
    const { mintGraphjinToken } = await import("../graphjin/token");
    const token = mintGraphjinToken({
      orgId: input.orgId,
      userId: gate.userId,
      role: "admin",
    });
    const timeout = AbortSignal.timeout(90_000);
    try {
      const agentStatus = await getGraphjinAgentStatus({
        baseUrl: src.graphqlUrl,
        token,
        signal: timeout,
      });
      const source = {
        id: src.id,
        name: src.name,
        host: hostnameOf(src.graphqlUrl),
      };
      if (!agentStatus.ready) {
        return {
          source,
          agentStatus,
          error: agentStatus.message || "GraphJin agent is not ready",
        };
      }
      if (!agentStatus.read_only) {
        return {
          denied: true,
          source,
          agentStatus,
          error:
            "GraphJin agent is not configured read-only; OpenNeko will not forward configuration instructions",
        };
      }
      const response = await askGraphjinAgent({
        baseUrl: src.graphqlUrl,
        token,
        signal: timeout,
        request: {
          instruction,
          max_steps: Math.min(Math.max(input.maxSteps ?? 8, 1), 12),
          return_trace: false,
          context: {
            caller: "OpenNeko admin chat",
            purpose: "configuration inspection and planning",
            constraint:
              "Read-only advisory request. Do not apply configuration or schema changes.",
          },
        },
      });
      return { source, agentStatus, response };
    } catch (err) {
      return {
        source: {
          id: src.id,
          name: src.name,
          host: hostnameOf(src.graphqlUrl),
        },
        error: (err instanceof Error ? err.message : String(err)).slice(0, 1_000),
      };
    }
  }

  async previewSourceConfigChange(input: {
    orgId: string;
    runId?: string | null;
    actorRole?: string | null;
    dataSourceId?: string;
    payload: Record<string, unknown>;
  }): Promise<SourceConfigPreviewResult> {
    const gate = await requireSourceConfigAccess(input);
    if (!gate.ok) return { denied: true, error: gate.error };

    const {
      and,
      data_source,
      data_source_secret,
      db,
      eq,
    } = await import("@neko/db");
    const sources = await db()
      .select({
        id: data_source.id,
        name: data_source.name,
        kind: data_source.kind,
        graphqlUrl: data_source.graphql_url,
      })
      .from(data_source)
      .where(
        and(
          eq(data_source.org_id, input.orgId),
          eq(data_source.enabled, true),
          ...(input.dataSourceId
            ? [eq(data_source.id, input.dataSourceId)]
            : []),
        ),
      )
      .limit(input.dataSourceId ? 1 : 3);
    if (sources.length === 0) {
      return { error: "no enabled customer GraphJin data source was found" };
    }
    if (!input.dataSourceId && sources.length > 1) {
      return {
        error:
          "multiple enabled data sources exist; choose a dataSourceId before previewing",
      };
    }
    const src = sources[0]!;
    const source = {
      id: src.id,
      name: src.name,
      host: hostnameOf(src.graphqlUrl),
    };
    if (src.kind !== "graphjin") {
      return { source, error: "the selected data source is not a GraphJin server" };
    }
    if (isInternalGraphjinURL(src.graphqlUrl)) {
      return {
        denied: true,
        source,
        error: "refusing to preview changes against the OpenNeko internal GraphJin",
      };
    }

    let secretValue = "";
    try {
      const {
        buildGraphjinConfigUpdate,
        graphjinConfigPatchHash,
        graphjinInputValue,
      } = await import("../graphjin/config-change");
      const { update } = await buildGraphjinConfigUpdate(
        input.payload,
        async (name) => {
          const [row] = await db()
            .select({ valueEnc: data_source_secret.value_enc })
            .from(data_source_secret)
            .where(
              and(
                eq(data_source_secret.org_id, input.orgId),
                eq(data_source_secret.name, name),
              ),
            )
            .limit(1);
          if (!row) {
            throw new Error(
              `no stored source secret named "${name}"; add it in GraphJin Config first`,
            );
          }
          const { maybeDecryptSecret } = await import("@neko/secret-crypt");
          secretValue = maybeDecryptSecret(row.valueEnc);
          return secretValue;
        },
      );
      // Hash only the credential-free, typed proposal. A password can be low
      // entropy; even its plain SHA-256 must never enter an approval payload.
      // Canonical JSON survives PostgreSQL JSONB key reordering.
      const patchHash = graphjinConfigPatchHash(input.payload);
      const { graphjinQuery } = await import("../graphjin/client");
      const { mintGraphjinToken } = await import("../graphjin/token");
      const token = mintGraphjinToken({
        orgId: input.orgId,
        userId: gate.userId,
        role: "admin",
        ttlSeconds: 120,
      });
      const headers = { authorization: `Bearer ${token}` };
      const revisionResponse = await graphjinQuery<{
        gj_config?: { catalog_revision?: string };
      }>({
        baseUrl: src.graphqlUrl,
        headers,
        query: 'query { gj_config(id: "current") { catalog_revision } }',
      });
      const revision = revisionResponse.data?.gj_config?.catalog_revision;
      if (!revision || revisionResponse.errors?.length) {
        return {
          source,
          error:
            revisionResponse.errors?.map((item) => item.message).join("; ") ||
            "GraphJin did not return catalog_revision",
        };
      }
      const literal = graphjinInputValue({
        mode: "preview",
        expected_catalog_revision: revision,
        ...update,
      });
      const response = await graphjinQuery<{
        gj_config?: {
          valid?: boolean;
          preview_id?: string;
          expires_at?: string;
          change_summary_json?: string;
          findings_json?: string;
          errors_json?: string;
        };
      }>({
        baseUrl: src.graphqlUrl,
        headers,
        query: `mutation { gj_config(id: "current", update: ${literal}) { valid preview_id expires_at change_summary_json findings_json errors_json } }`,
      });
      if (response.errors?.length) {
        return {
          source,
          error: response.errors.map((item) => item.message).join("; "),
        };
      }
      const row = response.data?.gj_config;
      const scrub = (value: string | undefined): string =>
        secretValue && secretValue.length >= 8
          ? (value ?? "").split(secretValue).join("[REDACTED]")
          : value ?? "";
      return {
        source,
        preview: {
          valid: row?.valid === true && Boolean(row.preview_id),
          patchHash,
          catalogRevision: revision,
          expiresAt: row?.expires_at ?? null,
          scope: null,
          reloadMode: null,
          changes: parseConfigPreviewJSON(scrub(row?.change_summary_json)),
          findings: parseConfigPreviewJSON(scrub(row?.findings_json)),
          errors: parseConfigPreviewJSON(scrub(row?.errors_json)),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        source,
        error:
          secretValue && secretValue.length >= 8
            ? message.split(secretValue).join("[REDACTED]").slice(0, 1_000)
            : message.slice(0, 1_000),
      };
    }
  }

  async listAuditTrail(input: {
    orgId: string;
    runId?: string | null;
    limit?: number;
  }) {
    const {
      action_request,
      behavior_alert,
      control_plane_audit,
      and,
      db,
      desc,
      eq,
      gte,
      sql,
      work_run,
    } = await import("@neko/db");
    // Server-side admin gate on the REQUESTING run's K1 actor.
    if (!input.runId) return { denied: true };
    const [run] = await db()
      .select({ role: work_run.actor_role })
      .from(work_run)
      .where(eq(work_run.id, input.runId))
      .limit(1);
    if (run?.role !== "admin") return { denied: true };

    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const requests = await db()
      .select()
      .from(action_request)
      .where(eq(action_request.org_id, input.orgId))
      .orderBy(desc(action_request.created_at))
      .limit(limit);
    const alerts = await db()
      .select()
      .from(behavior_alert)
      .where(eq(behavior_alert.org_id, input.orgId))
      .orderBy(desc(behavior_alert.created_at))
      .limit(limit);
    const daySince = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const gateway = await db()
      .select({
        runId: control_plane_audit.run_id,
        backend: control_plane_audit.backend,
        actorRole: control_plane_audit.actor_role,
        calls: sql<number>`count(*)::int`,
      })
      .from(control_plane_audit)
      .where(
        and(
          eq(control_plane_audit.org_id, input.orgId),
          gte(control_plane_audit.created_at, daySince),
        ),
      )
      .groupBy(
        control_plane_audit.run_id,
        control_plane_audit.backend,
        control_plane_audit.actor_role,
      )
      .orderBy(sql`count(*) desc`)
      .limit(limit);

    return {
      requests: requests.map((r) => ({
        id: r.id,
        kind: r.kind,
        target: r.target,
        status: r.status,
        scope: r.scope,
        summary: r.summary,
        actorUserId: r.actor_user_id,
        actorRole: r.actor_role,
        actorBackend: r.actor_backend,
        createdAt: r.created_at.toISOString(),
      })),
      alerts: alerts.map((a) => ({
        id: a.id,
        kind: a.kind,
        subject: a.subject,
        observed: a.observed,
        threshold: a.threshold,
        windowSeconds: a.window_seconds,
        acknowledgedAt: a.acknowledged_at?.toISOString() ?? null,
        createdAt: a.created_at.toISOString(),
      })),
      gatewaySummary: gateway,
    };
  }

  async listChannels(input: { orgId: string }) {
    const { channel_identity, channel_workspace, db, eq } = await import(
      "@neko/db"
    );
    const workspaces = await db()
      .select({
        channelPlugin: channel_workspace.channel_plugin,
        workspaceId: channel_workspace.workspace_id,
        createdAt: channel_workspace.created_at,
      })
      .from(channel_workspace)
      .where(eq(channel_workspace.org_id, input.orgId));
    const identities = await db()
      .select({
        id: channel_identity.id,
        channelPlugin: channel_identity.channel_plugin,
        workspaceId: channel_identity.workspace_id,
        channelUserId: channel_identity.channel_user_id,
        displayName: channel_identity.display_name,
        email: channel_identity.email,
        status: channel_identity.status,
        appUserId: channel_identity.app_user_id,
        firstSeenAt: channel_identity.first_seen_at,
        verifiedAt: channel_identity.verified_at,
      })
      .from(channel_identity)
      .where(eq(channel_identity.org_id, input.orgId));
    return {
      workspaces: workspaces.map((w) => ({
        ...w,
        createdAt: w.createdAt?.toISOString() ?? null,
      })),
      identities: identities.map((i) => ({
        ...i,
        firstSeenAt: i.firstSeenAt?.toISOString() ?? null,
        verifiedAt: i.verifiedAt?.toISOString() ?? null,
      })),
    };
  }
}

function hostnameOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isInternalGraphjinURL(url: string): boolean {
  try {
    const candidate = new URL(url).host;
    const internal = new URL(
      process.env.OPENNEKO_GRAPHJIN_URL ?? "http://127.0.0.1:8089",
    ).host;
    return candidate === internal;
  } catch {
    return true;
  }
}

function parseConfigPreviewJSON(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(0, 4_000);
  }
}

export const inProcessControlPlane: AgentControlPlane = new InProcessControlPlane();
