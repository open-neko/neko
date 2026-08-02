import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getOrgId } from "@/lib/db";
import {
  readRecordRecycleDetail,
  RecordAppRouteError,
} from "@/lib/records";
import { RecordAskBox } from "@/components/records/RecordAskBox";
import { RecordRestoreButton } from "@/components/records/RecordRestoreButton";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export default async function RecordRecycleDetailPage({
  params,
}: {
  params: Promise<{ app: string; object: string; id: string }>;
}) {
  const [{ app, object, id }, orgId] = await Promise.all([params, getOrgId()]);
  let result: Awaited<ReturnType<typeof readRecordRecycleDetail>> | null = null;
  let routeError: RecordAppRouteError | null = null;
  try {
    result = await readRecordRecycleDetail({
      orgId,
      appId: app,
      objectApiName: object,
      recordId: id,
    });
  } catch (error) {
    if (error instanceof RecordAppRouteError) {
      routeError = error;
    } else {
      throw error;
    }
  }

  if (routeError?.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!result?.row) notFound();
  const base = `/a/${result.app.appId}/${result.view.object.apiName}`;
  const recycleBase = `${base}/recycle`;
  const owner = result.row.ownerUserId
    ? result.owners[result.row.ownerUserId]
    : undefined;
  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link
          className="records-back"
          href={recycleBase}
          aria-label="Back to recycle bin"
        >
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div>
          <span className="records-breadcrumb">
            {result.app.label} / {result.view.object.pluralLabel} / Recycle bin
          </span>
          <h1>{result.row.recordName}</h1>
        </div>
        {result.view.permission.canUpdate && (
          <RecordRestoreButton
            appId={result.app.appId}
            objectApiName={result.view.object.apiName}
            recordId={result.row.recordId}
          />
        )}
      </header>
      <section className="records-detail-card" aria-label="Deleted record summary">
        <dl className="records-detail-grid">
          <div className="records-detail-field">
            <dt>Deleted</dt>
            <dd>
              <time dateTime={result.row.deletedAt}>
                {dateLabel(result.row.deletedAt)}
              </time>
            </dd>
          </div>
          <div className="records-detail-field">
            <dt>Deleted by</dt>
            <dd>{result.row.deletedBy ?? "—"}</dd>
          </div>
          <div className="records-detail-field">
            <dt>Owner</dt>
            <dd>{owner?.label ?? result.row.ownerUserId ?? "—"}</dd>
          </div>
          <div className="records-detail-field">
            <dt>Object</dt>
            <dd>{result.view.object.label}</dd>
          </div>
        </dl>
        <div className="records-detail-id">
          Record ID <code>{result.row.recordId}</code>
        </div>
      </section>
      <div className="records-recycle-warning">
        Deleted business fields stay sealed until the record is restored.
      </div>
      <RecordAskBox
        context={{
          surface: "recycle_detail",
          appId: result.app.appId,
          appLabel: result.app.label,
          objectApiName: result.view.object.apiName,
          objectLabel: result.view.object.label,
          recordId: result.row.recordId,
          recordLabel: result.row.recordName,
        }}
      />
    </main>
  );
}
