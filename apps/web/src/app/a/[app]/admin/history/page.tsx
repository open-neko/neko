import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getOrgId } from "@/lib/db";
import {
  getRecordAdminModel,
  RecordAdminPermissionError,
  RecordAppRouteError,
} from "@/lib/records";
import { RecordAdminNav } from "@/components/records/RecordAdminNav";
import { RecordSchemaHistory } from "@/components/records/RecordSchemaHistory";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

export default async function RecordHistoryPage({ params }: { params: Promise<{ app: string }> }) {
  const [{ app }, orgId] = await Promise.all([params, getOrgId()]);
  let model: Awaited<ReturnType<typeof getRecordAdminModel>> | null = null;
  let routeError: RecordAppRouteError | RecordAdminPermissionError | null = null;
  try {
    model = await getRecordAdminModel({ orgId, appId: app });
  } catch (error) {
    if (error instanceof RecordAppRouteError || error instanceof RecordAdminPermissionError) routeError = error;
    else throw error;
  }
  if (routeError instanceof RecordAppRouteError && routeError.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!model) throw new Error("History admin page did not resolve.");
  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link className="records-back" href={model.fallbackHref} aria-label={`Back to ${model.app.label}`}><ArrowLeft aria-hidden="true" /></Link>
        <div><span className="records-breadcrumb">{model.app.label} / Admin</span><h1>Schema history</h1></div>
        <RecordAdminNav appId={model.app.appId} active="history" />
      </header>
      <RecordSchemaHistory history={model.history} />
    </main>
  );
}
