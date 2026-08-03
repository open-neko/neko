import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { RecordReadPermissionError } from "@neko/records";
import { getOrgId } from "@/lib/db";
import { RecordAppRouteError } from "@/lib/records";
import {
  getRecordFormModel,
  RecordFormPolicyError,
} from "@/lib/records-actions";
import { RecordForm } from "@/components/records/RecordForm";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";

export const dynamic = "force-dynamic";

export default async function EditRecordPage({
  params,
}: {
  params: Promise<{ app: string; object: string; id: string }>;
}) {
  const [{ app, object, id }, orgId] = await Promise.all([params, getOrgId()]);
  let model: Awaited<ReturnType<typeof getRecordFormModel>>;
  try {
    model = await getRecordFormModel({
      orgId,
      appId: app,
      objectApiName: object,
      operation: "update",
      recordId: id,
    });
  } catch (error) {
    if (error instanceof RecordReadPermissionError) notFound();
    if (error instanceof RecordAppRouteError) {
      if (error.status === 404) notFound();
      return <RecordsUnavailable message={error.message} />;
    }
    if (error instanceof RecordFormPolicyError) {
      return <RecordsUnavailable message={error.message} />;
    }
    throw error;
  }
  if (!model.row || !model.recordId) notFound();
  const base = `/a/${model.appId}/${model.objectApiName}`;
  const detail = `${base}/${encodeURIComponent(model.recordId)}`;
  const name = String(
    model.row[model.nameField] ?? model.row.id ?? model.objectLabel,
  );
  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link className="records-back" href={detail} aria-label={`Back to ${name}`}>
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div>
          <span className="records-breadcrumb">
            {model.appLabel} / {model.objectPluralLabel}
          </span>
          <h1>Edit {name}</h1>
        </div>
      </header>
      <div className="records-form-wrap">
        <div className="records-form-intro">
          <span className="records-eyebrow">Governed update</span>
          <h2>Update {model.objectLabel.toLowerCase()}</h2>
          <p>The current values are included as a concurrency check before the worker writes.</p>
        </div>
        <RecordForm
          appId={model.appId}
          objectApiName={model.objectApiName}
          objectLabel={model.objectLabel}
          operation="update"
          fields={model.fields}
          initialRow={model.row}
          recordId={model.recordId}
        />
      </div>
    </main>
  );
}
