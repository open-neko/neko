import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { getOrgId } from "@/lib/db";
import { readRecordDetail, RecordAppRouteError } from "@/lib/records";
import { RecordCell } from "@/components/records/RecordCell";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

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
    const ownerId =
      typeof result.row.owner_user_id === "string" ? result.row.owner_user_id : null;
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
        <section className="records-detail-card">
          <div className="records-detail-grid">
            {result.view.columns.map((column) => (
              <div className="records-detail-field" key={column.apiName}>
                <dt>{column.label}</dt>
                <dd>
                  <RecordCell
                    appId={result.app.appId}
                    column={column}
                    value={result.row?.[column.columnName]}
                    owner={column.kind === "owner" && ownerId ? result.owners[ownerId] : undefined}
                  />
                </dd>
              </div>
            ))}
          </div>
          <footer className="records-detail-id">
            <span>Record ID</span>
            <code>{String(result.row.id)}</code>
          </footer>
        </section>
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

