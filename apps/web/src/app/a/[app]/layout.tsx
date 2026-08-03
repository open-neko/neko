import { notFound } from "next/navigation";
import { getOrgId } from "@/lib/db";
import { loadRecordAppShell, RecordAppRouteError } from "@/lib/records";
import { RecordsDegradedBanner } from "@/components/records/RecordsNotice";
import { recordsVisualTestEnabled } from "@/lib/records-visual-fixtures";

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
  return (
    <div className="records-app-shell">
      {shell.availability === "degraded" && (
        <RecordsDegradedBanner
          message={shell.degradedReason ?? "The app is degraded."}
        />
      )}
      {children}
    </div>
  );
}
