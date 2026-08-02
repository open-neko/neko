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

export default async function NewRecordPage({
  params,
}: {
  params: Promise<{ app: string; object: string }>;
}) {
  const [{ app, object }, orgId] = await Promise.all([params, getOrgId()]);
  let model: Awaited<ReturnType<typeof getRecordFormModel>>;
  try {
    model = await getRecordFormModel({
      orgId,
      appId: app,
      objectApiName: object,
      operation: "create",
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
  const base = `/a/${model.appId}/${model.objectApiName}`;
  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link className="records-back" href={base} aria-label={`Back to ${model.objectPluralLabel}`}>
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div>
          <span className="records-breadcrumb">
            {model.appLabel} / {model.objectPluralLabel}
          </span>
          <h1>New {model.objectLabel.toLowerCase()}</h1>
        </div>
      </header>
      <div className="records-form-wrap">
        <div className="records-form-intro">
          <span className="records-eyebrow">Governed create</span>
          <h2>Add {model.objectLabel.toLowerCase()}</h2>
          <p>Fields and required values come from the active app registry.</p>
        </div>
        <RecordForm
          appId={model.appId}
          objectApiName={model.objectApiName}
          objectLabel={model.objectLabel}
          operation="create"
          fields={model.fields}
        />
      </div>
    </main>
  );
}
