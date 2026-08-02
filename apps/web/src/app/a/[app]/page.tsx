import { notFound, redirect } from "next/navigation";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import {
  getRecordAppNav,
  loadRecordAppShell,
  RecordAppRouteError,
} from "@/lib/records";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

export default async function RecordAppHome({ params }: { params: Promise<{ app: string }> }) {
  const [{ app }, orgId, actor] = await Promise.all([
    params,
    getOrgId(),
    getCurrentActor(),
  ]);
  try {
    const shell = await loadRecordAppShell(orgId, app);
    if (shell.availability === "degraded") {
      return <RecordsUnavailable message={shell.degradedReason ?? "The app is degraded."} />;
    }
    const nav = await getRecordAppNav({
      orgId,
      appId: app,
      role: actor.role === "member" ? "member" : "admin",
    });
    const first = nav.objects[0];
    if (!first) notFound();
    redirect(`/a/${nav.appId}/${first.apiName}`);
  } catch (error) {
    if (error instanceof RecordAppRouteError && error.status === 404) notFound();
    throw error;
  }
}

