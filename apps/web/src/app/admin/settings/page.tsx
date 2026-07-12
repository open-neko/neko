import Link from "next/link";
import { connection } from "next/server";
import { data_source, db, eq, hasCustomPassword } from "@neko/db";
import AppHeader from "@/components/AppHeader";
import SectionNav from "@/components/SectionNav";
import { AdminDenied } from "@/app/admin/AdminShell";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { getSetupCompleteAt } from "@/lib/org-state";
import {
  getDataSourceSettings,
  hasDataSourceSetup,
} from "@/lib/data-source-settings";
import {
  getProviderSettingsPayload,
  hasPrimaryProviderSetup,
  resolveResearchStatus,
} from "@/lib/provider-settings";
import {
  getAgentBackendSettings,
  getAgentSettingsPayload,
} from "@/lib/agent-backend-settings";
import { getGraphjinConfigSettingsPayload } from "@/lib/graphjin-config-settings";
import SetupWizard from "./SetupWizard";

/**
 * Single admin surface — wizard until first-run is finished, then a
 * card index for ongoing edits. The wizard's gating (linear steps,
 * required-prereqs check on Finish) is preserved; the only thing
 * collapsed is the URL surface — admins no longer juggle /setup +
 * /settings as separate pages.
 *
 * The branch is decided server-side by setup_complete_at, so admins
 * can't bypass first-run gating by hitting a different URL.
 */
export default async function SettingsPage() {
  await connection();
  const actor = await getCurrentActor();
  if (actor.role !== "admin") return <AdminDenied />;

  const orgId = await getOrgId();
  const setupCompleteAt = await getSetupCompleteAt(orgId);

  // ── First-run mode: render the linear wizard. ──
  if (!setupCompleteAt) {
    const [dataSource, providers, agent] = await Promise.all([
      getDataSourceSettings(orgId),
      getProviderSettingsPayload(orgId),
      getAgentSettingsPayload(orgId),
    ]);
    return (
      <SetupWizard
        initial={{
          dataSource,
          providers,
          agent,
          passwordChanged: hasCustomPassword(),
        }}
      />
    );
  }

  // ── Ongoing-edits mode: card index linking to focused sub-pages. ──
  const [
    dataReady,
    primaryReady,
    researchStatus,
    agent,
    sources,
    graphjinConfig,
  ] = await Promise.all([
    hasDataSourceSetup(orgId),
    hasPrimaryProviderSetup(orgId),
    resolveResearchStatus(orgId),
    getAgentBackendSettings(orgId),
    db()
      .select({
        id: data_source.id,
        authMode: data_source.auth_mode,
        enabled: data_source.enabled,
      })
      .from(data_source)
      .where(eq(data_source.org_id, orgId)),
    getGraphjinConfigSettingsPayload(orgId),
  ]);

  const enabledSources = sources.filter((source) => source.enabled);
  const jwtSources = enabledSources.filter(
    (source) => source.authMode === "jwt",
  ).length;

  const cards: {
    href: string;
    title: string;
    copy: string;
    status?: string;
    statusOk?: boolean;
  }[] = [
    {
      href: "/admin/settings/data",
      title: "Data source",
      copy: "Graphjin server endpoint OpenNeko should connect to.",
      status: dataReady ? "Configured" : "Not set",
      statusOk: dataReady,
    },
    {
      href: "/admin/settings/agent",
      title: "Agent",
      copy:
        agent.backend === "claude-agent"
          ? "Claude Agent — locked to Anthropic primary provider."
          : "Hermes — works with any primary provider.",
      status: primaryReady ? `Backend: ${agent.backend}` : "Primary provider not set",
      statusOk: primaryReady,
    },
    {
      href: "/admin/settings/graphjin",
      title: "GraphJin Config",
      copy: "Source-mode endpoints and RBAC token claims passed to GraphJin.",
      status:
        graphjinConfig.settings.sourceConfigEnabled
          ? enabledSources.length === 0
            ? "MCP on · no source"
            : `MCP on · ${jwtSources}/${enabledSources.length} JWT`
          : "MCP config off",
      statusOk:
        graphjinConfig.settings.sourceConfigEnabled &&
        enabledSources.length > 0 &&
        jwtSources === enabledSources.length,
    },
    {
      href: "/admin/settings/research",
      title: "Research",
      copy: "Optional industry research run during onboarding.",
      status: researchStatus === "enabled" ? "Enabled" : "Disabled",
      statusOk: true,
    },
  ];
  cards.push({
    href: "/admin/settings/security",
    title: "Security",
    copy: "Trust floor for plugin and skill installs — which marketplaces are allowed, whether unverified or community installs are permitted.",
  });

  return (
    <div className="root">
      <AppHeader>
        <SectionNav current="admin" />
      </AppHeader>
      <div className="greet">Workspace settings.</div>
      <div className="greet-sub mb-6">
        Operator-side configuration. The business onboarding lives at /onboarding.
      </div>

      <div className="flex flex-col gap-4 mt-6">
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="settings-card block no-underline">
            <div className="settings-card-head">
              <div>
                <h2 className="settings-card-title">{card.title}</h2>
                <p className="settings-card-copy">{card.copy}</p>
              </div>
              {card.status ? (
                <div className="settings-source">
                  <strong className={card.statusOk ? "is-ok" : "is-warn"}>{card.status}</strong>
                </div>
              ) : null}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
