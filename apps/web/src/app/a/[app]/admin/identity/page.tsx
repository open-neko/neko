import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileUp, UsersRound } from "lucide-react";
import type { IdentityMappingStatus } from "@neko/records";
import { RecordIdentityPanel } from "@/components/records/RecordIdentityPanel";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";
import { getOrgId } from "@/lib/db";
import {
  getRecordIdentityAdminModel,
  RecordIdentityWebPermissionError,
} from "@/lib/records-identity";
import { RecordAppRouteError } from "@/lib/records";

export const dynamic = "force-dynamic";

const STATUSES = new Set<IdentityMappingStatus>([
  "linked",
  "unlinked",
  "conflict",
  "ignored",
]);

function identityStatus(value: string | undefined): IdentityMappingStatus | undefined {
  return value && STATUSES.has(value as IdentityMappingStatus)
    ? (value as IdentityMappingStatus)
    : undefined;
}

export default async function RecordIdentityAdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ app: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ app }, query, orgId] = await Promise.all([params, searchParams, getOrgId()]);
  const status = identityStatus(query.status);
  let model: Awaited<ReturnType<typeof getRecordIdentityAdminModel>> | null = null;
  let routeError: RecordAppRouteError | RecordIdentityWebPermissionError | null = null;
  try {
    model = await getRecordIdentityAdminModel({ orgId, appId: app, status });
  } catch (error) {
    if (
      error instanceof RecordAppRouteError ||
      error instanceof RecordIdentityWebPermissionError
    ) {
      routeError = error;
    } else {
      throw error;
    }
  }

  if (routeError instanceof RecordAppRouteError && routeError.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!model) throw new Error("Identity admin page did not resolve.");

  return (
    <main className="records-root records-detail-root">
      <header className="records-detail-header">
        <Link className="records-back" href={model.fallbackHref} aria-label={`Back to ${model.appLabel}`}>
          <ArrowLeft aria-hidden="true" />
        </Link>
        <div>
          <span className="records-breadcrumb">{model.appLabel} / Admin</span>
          <h1>Identity mapping</h1>
        </div>
        <nav className="records-admin-nav" aria-label="App administration">
          <Link href={`/a/${model.appId}/admin`}>
            <FileUp aria-hidden="true" /> Import
          </Link>
          <Link className="is-active" href={`/a/${model.appId}/admin/identity`}>
            <UsersRound aria-hidden="true" /> Identity
          </Link>
        </nav>
      </header>
      <RecordIdentityPanel
        appId={model.appId}
        mappings={model.mappings}
        users={model.users}
        counts={model.counts}
        activeFilter={status ?? "all"}
      />
    </main>
  );
}
