import { notFound } from "next/navigation";
import { getOrgId } from "@/lib/db";
import { loadRecordAppShell, RecordAppRouteError } from "@/lib/records";
import { RecordsDegradedBanner } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

export default async function RecordAppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ app: string }>;
}) {
  const [{ app }, orgId] = await Promise.all([params, getOrgId()]);
  try {
    const shell = await loadRecordAppShell(orgId, app);
    return (
      <div className="records-app-shell">
        {shell.availability === "degraded" && (
          <RecordsDegradedBanner message={shell.degradedReason ?? "The app is degraded."} />
        )}
        {children}
      </div>
    );
  } catch (error) {
    if (error instanceof RecordAppRouteError && error.status === 404) notFound();
    throw error;
  }
}

