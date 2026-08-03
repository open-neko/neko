import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Database } from "lucide-react";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import {
  getRecordAppNav,
  getRecordSubstrateStatus,
  loadRecordAppShell,
  readRecordAppPage,
  RecordAppRouteError,
} from "@/lib/records";
import { RecordAppPage } from "@/components/records/RecordAppPage";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";
import { SubstrateStrip } from "@/components/records/SubstrateStrip";

export const dynamic = "force-dynamic";

export default async function RecordAppHome({ params }: { params: Promise<{ app: string }> }) {
  const [{ app }, orgId, actor] = await Promise.all([
    params,
    getOrgId(),
    getCurrentActor(),
  ]);
  let loaded:
    | { kind: "degraded"; message: string }
    | {
        kind: "active";
        nav: Awaited<ReturnType<typeof getRecordAppNav>>;
        page: Awaited<ReturnType<typeof readRecordAppPage>>;
        substrate: Awaited<ReturnType<typeof getRecordSubstrateStatus>>;
      }
    | null = null;
  let routeError: RecordAppRouteError | null = null;
  try {
    const shell = await loadRecordAppShell(orgId, app);
    if (shell.availability === "degraded") {
      loaded = {
        kind: "degraded",
        message: shell.degradedReason ?? "The app is degraded.",
      };
    } else {
      const [nav, page, substrate] = await Promise.all([
        getRecordAppNav({
          orgId,
          appId: app,
          role: actor.role === "member" ? "member" : "admin",
        }),
        readRecordAppPage({ orgId, appId: app }),
        getRecordSubstrateStatus({ orgId, appId: app }),
      ]);
      loaded = { kind: "active", nav, page, substrate };
    }
  } catch (error) {
    if (error instanceof RecordAppRouteError) {
      routeError = error;
    } else {
      throw error;
    }
  }
  if (routeError?.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!loaded) throw new Error("Record app home did not resolve.");
  if (loaded.kind === "degraded") return <RecordsUnavailable message={loaded.message} />;
  const { nav, page, substrate } = loaded;
  return (
    <main className="records-root records-app-home">
      <header className="records-home-header">
        <div>
          <span className="records-breadcrumb">Generated application</span>
          <h1>{nav.label}</h1>
          {nav.purpose && <p>{nav.purpose}</p>}
        </div>
      </header>
      {page ? (
        <RecordAppPage result={page} />
      ) : (
        <section className="records-object-grid" aria-label={`${nav.label} objects`}>
          {nav.objects.map((object) => (
            <Link href={`/a/${nav.appId}/${object.apiName}`} key={object.apiName}>
              <Database aria-hidden="true" />
              <span>
                <strong>{object.pluralLabel}</strong>
                <small>
                  {object.recordCount === null
                    ? "Browse records"
                    : `${Number(object.recordCount).toLocaleString("en")} records`}
                </small>
              </span>
              <ArrowRight aria-hidden="true" />
            </Link>
          ))}
        </section>
      )}
      <SubstrateStrip status={substrate} />
    </main>
  );
}
