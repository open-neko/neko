import { execFile } from "node:child_process";
import {
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_URL,
  readManifest,
  removeEntry,
  runInstall,
  writeManifest,
} from "@open-neko/plugin-install";
import { randomUUID } from "node:crypto";
import { registerActionAdapter } from "@neko/llm/workflows";
import {
  buildGraphjinConfigUpdate,
  graphjinConfigPatchHash,
  graphjinInputValue,
} from "@neko/llm/graphjin";

/**
 * ADM3 — executes approved plugin_install / plugin_uninstall action
 * requests. The chat agent can only PROPOSE these (policy-gated); the
 * worker executes after approval, reusing the CLI's install machinery
 * (marketplace pin + integrity + install-policy snapshot). Required env
 * keys are never prompted through this path — a missing key fails the
 * action with a pointer to the secrets flow.
 */
export function registerPluginManagementAdapters(opts: {
  repoRoot: string;
  getInstallPolicy: () => Promise<{
    allowUnverified: boolean;
    allowGitUrlInstalls: boolean;
    allowSandboxedSkillEscape: boolean;
    allowedMarketplaces: string[];
  }>;
}): void {
  registerActionAdapter("plugin_install", async ({ request }) => {
    const spec = String(
      (request.payload as Record<string, unknown>).spec ?? "",
    ).trim();
    if (!spec) throw new Error("plugin_install: payload.spec is required");
    const policy = await opts.getInstallPolicy();
    const result = await runInstall({
      spec,
      repoRoot: opts.repoRoot,
      trustedMarketplaces: [
        { name: OFFICIAL_MARKETPLACE_NAME, url: OFFICIAL_MARKETPLACE_URL },
      ],
      npmRunner: (args, cwd) =>
        new Promise<void>((resolve, reject) => {
          execFile("npm", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err) =>
            err ? reject(err) : resolve(),
          );
        }),
      envPrompt: async (plugin, requirement) => {
        throw new Error(
          `${plugin} requires ${requirement.key}. Set it first (openneko secrets set ${plugin} ${requirement.key} …) and re-approve the install — credentials never flow through chat.`,
        );
      },
      policySnapshot: policy,
    });
    return {
      commandOrOperation: `install ${spec}`,
      result: {
        name: result.name,
        version: result.version,
        source: result.source,
        network: result.permissions.network,
        envAlreadySet: result.envAlreadySet,
      },
    };
  });

  registerActionAdapter("plugin_uninstall", async ({ request }) => {
    const name = String(
      (request.payload as Record<string, unknown>).name ?? "",
    ).trim();
    if (!name) throw new Error("plugin_uninstall: payload.name is required");
    const manifest = await readManifest(opts.repoRoot);
    if (!manifest || !manifest.plugins.some((p) => p.name === name)) {
      throw new Error(`plugin_uninstall: ${name} is not installed`);
    }
    await writeManifest(opts.repoRoot, removeEntry(manifest, name));
    return {
      commandOrOperation: `uninstall ${name}`,
      result: { name, removed: true },
    };
  });
}

/**
 * ADM1 — executes approved user_admin action requests (admin-approved
 * per the user_management_default policy; K2 enforces the approver).
 * invite pre-creates the app_user row so SSO links by email on first
 * sign-in; deactivate sets disabled_at — sign-in and live sessions both
 * die on it.
 */
export function registerUserAdminAdapter(): void {
  registerActionAdapter("user_admin", async ({ request }) => {
    const { app_user, and, db, eq } = await import("@neko/db");
    const payload = request.payload as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const orgId = request.orgId;

    if (action === "invite") {
      const email = String(payload.email ?? "").trim().toLowerCase();
      const role = payload.role === "admin" ? "admin" : "member";
      if (!email) throw new Error("user_admin invite: email required");
      const [existing] = await db()
        .select({ id: app_user.id })
        .from(app_user)
        .where(and(eq(app_user.org_id, orgId), eq(app_user.email, email)))
        .limit(1);
      if (existing) {
        return {
          commandOrOperation: `invite ${email}`,
          result: { userId: existing.id, alreadyExisted: true },
        };
      }
      const id = randomUUID();
      await db().insert(app_user).values({ id, email, org_id: orgId, role });
      return {
        commandOrOperation: `invite ${email} as ${role}`,
        result: { userId: id, role },
      };
    }

    const userId = String(payload.userId ?? "");
    if (!userId) throw new Error(`user_admin ${action}: userId required`);
    const where = and(eq(app_user.org_id, orgId), eq(app_user.id, userId));

    if (action === "set_role") {
      const role = payload.role === "admin" ? "admin" : "member";
      const rows = await db()
        .update(app_user)
        .set({ role, updated_at: new Date() })
        .where(where)
        .returning({ id: app_user.id });
      if (rows.length === 0) throw new Error(`user ${userId} not found`);
      return { commandOrOperation: `set_role ${userId} ${role}`, result: { userId, role } };
    }
    if (action === "deactivate" || action === "reactivate") {
      const disabled_at = action === "deactivate" ? new Date() : null;
      const rows = await db()
        .update(app_user)
        .set({ disabled_at, updated_at: new Date() })
        .where(where)
        .returning({ id: app_user.id });
      if (rows.length === 0) throw new Error(`user ${userId} not found`);
      return {
        commandOrOperation: `${action} ${userId}`,
        result: { userId, disabled: action === "deactivate" },
      };
    }
    throw new Error(`user_admin: unknown action "${action}"`);
  });
}

/**
 * ADM5 — executes approved channel_admin action requests (admin-approved
 * per the channel_management_default policy). Same verbs as the
 * admin-map API: link an identity to an app_user, unlink it back to
 * anonymous, block/unblock it.
 */
export function registerChannelAdminAdapter(): void {
  registerActionAdapter("channel_admin", async ({ request }) => {
    const { and, app_user, channel_identity, db, eq, isNull } = await import(
      "@neko/db"
    );
    const payload = request.payload as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const identityId = String(payload.identityId ?? "");
    const orgId = request.orgId;
    if (!identityId) throw new Error(`channel_admin ${action}: identityId required`);
    const where = and(
      eq(channel_identity.org_id, orgId),
      eq(channel_identity.id, identityId),
    );
    const now = new Date();

    if (action === "link") {
      const appUserId = String(payload.appUserId ?? "");
      const [user] = await db()
        .select({ id: app_user.id })
        .from(app_user)
        .where(
          and(
            eq(app_user.org_id, orgId),
            eq(app_user.id, appUserId),
            isNull(app_user.disabled_at),
          ),
        )
        .limit(1);
      if (!user) throw new Error(`channel_admin link: unknown or disabled user ${appUserId}`);
      const rows = await db()
        .update(channel_identity)
        .set({
          app_user_id: user.id,
          status: "linked",
          verified_at: now,
          updated_at: now,
        })
        .where(where)
        .returning({ id: channel_identity.id });
      if (rows.length === 0) throw new Error(`channel identity ${identityId} not found`);
      return {
        commandOrOperation: `link ${identityId} → ${appUserId}`,
        result: { identityId, appUserId, status: "linked" },
      };
    }

    if (action === "unlink" || action === "block" || action === "unblock") {
      const rows = await db()
        .update(channel_identity)
        .set({
          ...(action === "block"
            ? { status: "blocked" }
            : { app_user_id: null, status: "unverified", verified_at: null }),
          updated_at: now,
        })
        .where(where)
        .returning({ id: channel_identity.id, status: channel_identity.status });
      if (rows.length === 0) throw new Error(`channel identity ${identityId} not found`);
      return {
        commandOrOperation: `${action} ${identityId}`,
        result: { identityId, status: rows[0].status },
      };
    }

    throw new Error(`channel_admin: unknown action "${action}"`);
  });
}

/**
 * ADM2 — executes approved data_source_admin action requests. register
 * creates a DISABLED placeholder row (no connection details — the admin
 * fills those in Settings; credentials never pass through chat);
 * enable/disable/set_default/remove manage the registry.
 */
export function registerDataSourceAdminAdapter(): void {
  registerActionAdapter("data_source_admin", async ({ request }) => {
    const { and, data_source, db, eq, ne } = await import("@neko/db");
    const payload = request.payload as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const name = String(payload.name ?? "").trim();
    const orgId = request.orgId;
    if (!name) throw new Error(`data_source_admin ${action}: name required`);
    const byName = and(eq(data_source.org_id, orgId), eq(data_source.name, name));
    const now = new Date();

    if (action === "register") {
      const [existing] = await db()
        .select({ id: data_source.id })
        .from(data_source)
        .where(byName)
        .limit(1);
      if (existing) {
        return {
          commandOrOperation: `register ${name}`,
          result: { name, alreadyExisted: true },
        };
      }
      const SOURCE_KINDS = ["graphjin", "database", "api", "files", "code"];
      const sourceKind =
        typeof payload.sourceKind === "string" && SOURCE_KINDS.includes(payload.sourceKind)
          ? payload.sourceKind
          : "graphjin";
      const [row] = await db()
        .insert(data_source)
        .values({
          org_id: orgId,
          kind: sourceKind,
          graphql_url: "",
          name,
          label: typeof payload.label === "string" ? payload.label : null,
          enabled: false,
        })
        .returning({ id: data_source.id });
      return {
        commandOrOperation: `register ${name} (placeholder — complete in Settings)`,
        result: { id: row.id, name, enabled: false },
      };
    }

    if (action === "enable" || action === "disable") {
      const rows = await db()
        .update(data_source)
        .set({ enabled: action === "enable", updated_at: now })
        .where(byName)
        .returning({ id: data_source.id });
      if (rows.length === 0) throw new Error(`data source ${name} not found`);
      return {
        commandOrOperation: `${action} ${name}`,
        result: { name, enabled: action === "enable" },
      };
    }

    if (action === "set_default") {
      const rows = await db()
        .update(data_source)
        .set({ is_default: true, updated_at: now })
        .where(byName)
        .returning({ id: data_source.id });
      if (rows.length === 0) throw new Error(`data source ${name} not found`);
      await db()
        .update(data_source)
        .set({ is_default: false, updated_at: now })
        .where(and(eq(data_source.org_id, orgId), ne(data_source.name, name)));
      return { commandOrOperation: `set_default ${name}`, result: { name } };
    }

    if (action === "remove") {
      const [row] = await db()
        .select({ id: data_source.id, isDefault: data_source.is_default })
        .from(data_source)
        .where(byName)
        .limit(1);
      if (!row) throw new Error(`data source ${name} not found`);
      if (row.isDefault) {
        throw new Error("cannot remove the default data source — set another default first");
      }
      await db().delete(data_source).where(byName);
      return { commandOrOperation: `remove ${name}`, result: { name, removed: true } };
    }

    throw new Error(`data_source_admin: unknown action "${action}"`);
  });
}

/** OL5: the internal GraphJin endpoint the customer config path must never touch. */
function internalGraphjinHost(): string | null {
  try {
    return new URL(
      process.env.OPENNEKO_GRAPHJIN_URL ?? "http://127.0.0.1:8089",
    ).host;
  } catch {
    return null;
  }
}

function graphqlEndpointFrom(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1/graphql")
    ? trimmed
    : `${trimmed}/api/v1/graphql`;
}

/**
 * OL5 — executes approved source_config_admin actions: configure the
 * CUSTOMER GraphJin (roles, per-source access, source registration) via
 * its admin-only gj_config two-phase preview→apply. Three guarantees:
 *   1. Target is resolved ONLY from data_source (the customer engine);
 *      a host matching OPENNEKO_GRAPHJIN_URL is refused outright.
 *   2. The agent never holds config-write power — it only proposes; this
 *      adapter (post-approval, outside the sandbox) applies with a minted
 *      admin token.
 *   3. Connection secrets stay value-blind to the agent: a payload carries
 *      a secretRef NAME; the real value is resolved + decrypted here and
 *      injected into the gj_config source — never in the agent, payload, or
 *      audit row.
 */
export function registerSourceConfigAdminAdapter(): void {
  registerActionAdapter("source_config_admin", async ({ request }) => {
    const {
      data_source,
      data_source_secret,
      app_user,
      and,
      db,
      desc,
      eq,
      getGraphjinConfigSettingsForOrg,
    } = await import("@neko/db");
    const { graphjinQuery, mintGraphjinToken } = await import("@neko/llm/graphjin");
    const payload = request.payload as Record<string, unknown>;
    const action = String(payload.action ?? "");
    const orgId = request.orgId;

    const settings = await getGraphjinConfigSettingsForOrg(orgId);
    if (!settings.sourceConfigEnabled) {
      throw new Error(
        "source_config_admin: GraphJin config capability is disabled",
      );
    }

    const dataSourceId =
      typeof payload.dataSourceId === "string" ? payload.dataSourceId : null;
    const sources = await db()
      .select({ id: data_source.id, graphqlUrl: data_source.graphql_url })
      .from(data_source)
      .where(
        and(
          eq(data_source.org_id, orgId),
          eq(data_source.enabled, true),
          ...(dataSourceId ? [eq(data_source.id, dataSourceId)] : []),
        ),
      )
      .orderBy(desc(data_source.is_default), data_source.created_at)
      .limit(dataSourceId ? 1 : 3);
    if (!dataSourceId && sources.length > 1) {
      throw new Error(
        "source_config_admin: multiple enabled data sources exist; an explicit dataSourceId is required",
      );
    }
    const [src] = sources;
    if (!src?.graphqlUrl) {
      throw new Error("source_config_admin: no data source configured");
    }
    const endpoint = graphqlEndpointFrom(src.graphqlUrl);
    // BOUNDARY: never configure the OpenNeko internal GraphJin.
    const internal = internalGraphjinHost();
    let endpointHost: string;
    try {
      endpointHost = new URL(endpoint).host;
    } catch {
      throw new Error(`source_config_admin: invalid data source URL ${endpoint}`);
    }
    if (internal && endpointHost === internal) {
      throw new Error(
        "source_config_admin: refusing to configure the OpenNeko internal GraphJin",
      );
    }

    const { update, secretName } = await buildGraphjinConfigUpdate(
      payload,
      async (ref) => {
        const [row] = await db()
          .select({ valueEnc: data_source_secret.value_enc })
          .from(data_source_secret)
          .where(
            and(
              eq(data_source_secret.org_id, orgId),
              eq(data_source_secret.name, ref),
            ),
          )
          .limit(1);
        if (!row) {
          throw new Error(
            `register_source: no stored secret named "${ref}" — add it in GraphJin Config first`,
          );
        }
        const { maybeDecryptSecret } = await import("@neko/llm/secrets");
        return maybeDecryptSecret(row.valueEnc);
      },
    );
    const approvedPreview =
      payload.preview && typeof payload.preview === "object"
        ? (payload.preview as Record<string, unknown>)
        : null;
    if (!approvedPreview) {
      throw new Error(
        "source_config_admin: approved request is missing a validated preview",
      );
    }
    const credentialFreePayload = { ...payload };
    delete credentialFreePayload.preview;
    const patchHash = graphjinConfigPatchHash(credentialFreePayload);
    if (approvedPreview.patchHash !== patchHash) {
      throw new Error(
        "source_config_admin: approved payload no longer matches its preview",
      );
    }

    if (request.approvedByUserId) {
      const [approver] = await db()
        .select({ role: app_user.role, disabledAt: app_user.disabled_at })
        .from(app_user)
        .where(
          and(
            eq(app_user.id, request.approvedByUserId),
            eq(app_user.org_id, orgId),
          ),
        )
        .limit(1);
      if (!approver || approver.role !== "admin" || approver.disabledAt) {
        throw new Error(
          "source_config_admin: approving user is no longer an active admin",
        );
      }
    } else if (request.actorRole !== "admin") {
      throw new Error(
        "source_config_admin: missing trusted admin approval provenance",
      );
    }
    const adminToken = mintGraphjinToken({
      orgId,
      userId: request.approvedByUserId ?? request.actorUserId ?? null,
      role: "admin",
      ttlSeconds: 120,
    });
    const headers = { authorization: `Bearer ${adminToken}` };

    // Phase 0: read the current catalog_revision — the two-phase apply needs
    // it for optimistic concurrency (a stale value rejects the apply).
    const revRes = await graphjinQuery<{
      gj_config?: { catalog_revision?: string };
    }>({
      baseUrl: endpoint,
      headers,
      query: 'query { gj_config(id: "current") { catalog_revision } }',
    });
    const rev = revRes.data?.gj_config?.catalog_revision;
    if (!rev) {
      throw new Error(
        `source_config_admin: could not read catalog_revision: ${revRes.errors?.map((e) => e.message).join("; ") ?? "no revision"}`,
      );
    }
    if (approvedPreview.catalogRevision !== rev) {
      throw new Error(
        "source_config_admin: GraphJin configuration changed after approval; create and approve a fresh preview",
      );
    }

    // Phase 1: preview (validates without applying). Inline object syntax —
    // introspection is off, so no typed `$update` variable.
    const previewInline = graphjinInputValue({ mode: "preview", expected_catalog_revision: rev, ...update });
    const preview = await graphjinQuery<{
      gj_config?: {
        valid?: boolean;
        preview_id?: string;
        change_summary_json?: string;
        errors_json?: string;
      };
    }>({
      baseUrl: endpoint,
      headers,
      query: `mutation { gj_config(id: "current", update: ${previewInline}) { valid preview_id change_summary_json errors_json } }`,
    });
    if (preview.errors?.length) {
      throw new Error(
        `source_config_admin preview failed: ${preview.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const pv = preview.data?.gj_config;
    if (!pv?.valid || !pv.preview_id) {
      throw new Error(
        `source_config_admin preview invalid: ${pv?.errors_json ?? "no preview_id returned"}`,
      );
    }

    // Phase 2: apply with the same preview_id + identical payload.
    const applyInline = graphjinInputValue({
      mode: "apply",
      preview_id: pv.preview_id,
      expected_catalog_revision: rev,
      ...update,
    });
    const applied = await graphjinQuery<{
      gj_config?: { applied?: boolean; catalog_revision?: string; errors_json?: string };
    }>({
      baseUrl: endpoint,
      headers,
      query: `mutation { gj_config(id: "current", update: ${applyInline}) { applied catalog_revision errors_json } }`,
    });
    if (applied.errors?.length) {
      throw new Error(
        `source_config_admin apply failed: ${applied.errors.map((e) => e.message).join("; ")}`,
      );
    }
    const av = applied.data?.gj_config;
    if (!av?.applied) {
      throw new Error(`source_config_admin apply rejected: ${av?.errors_json ?? "unknown"}`);
    }

    return {
      commandOrOperation: `${action} on customer GraphJin (${endpointHost})`,
      result: {
        action,
        host: endpointHost,
        changeSummary: pv.change_summary_json ?? null,
        catalogRevision: av.catalog_revision ?? null,
        // Name only — never the value.
        ...(secretName ? { secretRef: secretName } : {}),
      },
    };
  });
}
