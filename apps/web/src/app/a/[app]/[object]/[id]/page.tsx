import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { getOrgId } from "@/lib/db";
import { readRecordDetail, RecordAppRouteError } from "@/lib/records";
import { RecordDetailCard } from "@/components/records/RecordDetailCard";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";
import { RecordAskBox } from "@/components/records/RecordAskBox";

export const dynamic = "force-dynamic";

export default async function RecordDetailPage({
  params,
}: {
  params: Promise<{ app: string; object: string; id: string }>;
}) {
  const [{ app, object, id }, orgId] = await Promise.all([params, getOrgId()]);
  try {
    const result = await readRecordDetail({
      orgId,
      appId: app,
      objectApiName: object,
      recordId: id,
    });
    if (!result.row) notFound();
    const base = `/a/${result.app.appId}/${result.view.object.apiName}`;
    const name = String(result.row[result.view.object.nameField] ?? result.row.id ?? "Record");
    return (
      <main className="records-root records-detail-root">
        <header className="records-detail-header">
          <Link className="records-back" href={base} aria-label={`Back to ${result.view.object.pluralLabel}`}>
            <ArrowLeft aria-hidden="true" />
          </Link>
          <div>
            <span className="records-breadcrumb">
              {result.app.label} / {result.view.object.pluralLabel}
            </span>
            <h1>{name}</h1>
          </div>
          {result.view.permission.canUpdate && (
            <Link className="records-secondary-action" href={`${base}/${encodeURIComponent(String(result.row.id))}/edit`}>
              <Pencil aria-hidden="true" /> Edit
            </Link>
          )}
        </header>
        <RecordDetailCard
          appId={result.app.appId}
          view={result.view}
          row={result.row}
          owners={result.owners}
        />
        <RecordAskBox
          context={{
            surface: "detail",
            appId: result.app.appId,
            appLabel: result.app.label,
            objectApiName: result.view.object.apiName,
            objectLabel: result.view.object.label,
            recordId: String(result.row.id),
            recordLabel: name,
          }}
        />
      </main>
    );
  } catch (error) {
    if (error instanceof RecordAppRouteError) {
      if (error.status === 404) notFound();
      return <RecordsUnavailable message={error.message} />;
    }
    throw error;
  }
}
