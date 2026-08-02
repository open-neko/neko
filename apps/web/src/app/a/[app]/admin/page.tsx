import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getOrgId } from "@/lib/db";
import {
  getRecordImportAdminModel,
  RecordImportWebPermissionError,
} from "@/lib/records-imports";
import { RecordAppRouteError } from "@/lib/records";
import { RecordImportPanel } from "@/components/records/RecordImportPanel";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

export default async function RecordAppAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ app: string }>;
  searchParams: Promise<{ object?: string }>;
}) {
  const [{ app }, query, orgId] = await Promise.all([params, searchParams, getOrgId()]);
  let model: Awaited<ReturnType<typeof getRecordImportAdminModel>> | null = null;
  let routeError: RecordAppRouteError | RecordImportWebPermissionError | null = null;
  try {
    model = await getRecordImportAdminModel({ orgId, appId: app });
  } catch (error) {
    if (
      error instanceof RecordAppRouteError ||
      error instanceof RecordImportWebPermissionError
    ) {
      routeError = error;
    } else {
      throw error;
    }
  }

  if (routeError instanceof RecordAppRouteError && routeError.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!model) throw new Error("Import admin page did not resolve.");

  const fallback = model.objects[0];
  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link
          className="records-back"
          href={fallback ? `/a/${model.appId}/${fallback.apiName}` : `/a/${model.appId}`}
          aria-label={`Back to ${model.appLabel}`}
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div>
          <span className="records-breadcrumb">{model.appLabel} / Admin</span>
          <h1>Import data</h1>
        </div>
      </header>
      <RecordImportPanel
        appId={model.appId}
        objects={model.objects}
        recentRuns={model.recentRuns}
        initialObject={query.object}
      />
    </main>
  );
}
