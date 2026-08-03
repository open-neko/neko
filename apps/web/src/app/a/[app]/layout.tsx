import { notFound } from "next/navigation";
import { getOrgId } from "@/lib/db";
import { loadRecordAppShell, RecordAppRouteError } from "@/lib/records";
import { RecordsDegradedBanner } from "@/components/records/RecordsNotice";
import { recordsVisualTestEnabled } from "@/lib/records-visual-fixtures";
import { AppChatSidebar } from "@/components/records/AppChatSidebar";

export const dynamic = "force-dynamic";

async function loadShell(orgId: string, appId: string) {
  try {
    return await loadRecordAppShell(orgId, appId);
  } catch (error) {
    if (error instanceof RecordAppRouteError && error.status === 404) notFound();
    throw error;
  }
}

export default async function RecordAppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ app: string }>;
}) {
  const { app } = await params;
  if (recordsVisualTestEnabled()) {
    return <div className="records-app-shell">{children}</div>;
  }
  const orgId = await getOrgId();
  const shell = await loadShell(orgId, app);
  const chatObjects = shell.snapshot.objects
    .filter((object) => object.archivedAt === null)
    .map((object) => ({
      apiName: object.apiName,
      label: object.label,
      pluralLabel: object.pluralLabel,
    }));
  return (
    <div className="records-app-shell">
      {shell.availability === "degraded" && (
        <RecordsDegradedBanner
          message={shell.degradedReason ?? "The app is degraded."}
        />
      )}
      <div className="records-app-frame">
        <div className="records-app-content">{children}</div>
        <AppChatSidebar
          key={shell.snapshot.app.appId}
          appId={shell.snapshot.app.appId}
          appLabel={shell.snapshot.app.label}
          objects={chatObjects}
        />
      </div>
    </div>
  );
}
