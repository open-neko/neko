import { AppsOverview } from "@/components/records/AppsOverview";
import { getCurrentActor } from "@/lib/actor";
import { getOrgId } from "@/lib/db";
import { listRecordAppsForViewer } from "@/lib/records";

export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const [orgId, actor] = await Promise.all([getOrgId(), getCurrentActor()]);
  let apps: Awaited<ReturnType<typeof listRecordAppsForViewer>> = [];
  let unavailable = false;
  try {
    apps = await listRecordAppsForViewer({
      orgId,
      role: actor.role === "member" ? "member" : "admin",
    });
  } catch (error) {
    console.error("[apps-overview] failed to load apps", error);
    unavailable = true;
  }
  return (
    <AppsOverview
      apps={apps}
      canCreate={actor.role === "admin"}
      unavailable={unavailable}
    />
  );
}
