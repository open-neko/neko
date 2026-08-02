import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { getOrgId } from "@/lib/db";
import {
  getRecordSubstrateStatus,
  loadRecordAppShell,
  readRecordList,
  RecordAppRouteError,
} from "@/lib/records";
import { RecordTable } from "@/components/records/RecordTable";
import { RecordViewBar } from "@/components/records/RecordViewBar";
import { RecordsUnavailable } from "@/components/records/RecordsNotice";
import { SubstrateStrip } from "@/components/records/SubstrateStrip";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function value(params: SearchParams, key: string): string | undefined {
  const candidate = params[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function positivePage(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed < 10_000 ? parsed : 1;
}

export default async function RecordObjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ app: string; object: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ app, object }, queryParams, orgId] = await Promise.all([
    params,
    searchParams,
    getOrgId(),
  ]);
  try {
    const shell = await loadRecordAppShell(orgId, app);
    if (shell.availability === "degraded") {
      return <RecordsUnavailable message={shell.degradedReason ?? "The app is degraded."} />;
    }
    const direction = value(queryParams, "direction") === "desc" ? "desc" : "asc";
    const sortField = value(queryParams, "sort");
    const page = positivePage(value(queryParams, "page"));
    const [result, substrate] = await Promise.all([
      readRecordList({
        orgId,
        appId: app,
        objectApiName: object,
        first: 50,
        after: value(queryParams, "after"),
        search: value(queryParams, "q"),
        sort: sortField ? { field: sortField, direction } : undefined,
        myRecords: value(queryParams, "mine") === "true",
      }),
      getRecordSubstrateStatus({ orgId, appId: app }),
    ]);
    const base = `/a/${result.app.appId}/${result.view.object.apiName}`;
    const query = {
      q: value(queryParams, "q"),
      sort: sortField,
      direction: value(queryParams, "direction"),
      mine: value(queryParams, "mine"),
      after: value(queryParams, "after"),
      page: value(queryParams, "page"),
    };
    return (
      <main className="records-root">
        <header className="records-object-header">
          <div className="records-object-title">
            <span className="records-breadcrumb">{result.app.label}</span>
            <span aria-hidden="true">/</span>
            <h1>{result.view.object.pluralLabel}</h1>
            <span className="records-total">{result.total.toLocaleString("en")} records</span>
          </div>
          <form className="records-search" action={base} method="get">
            <Search aria-hidden="true" />
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              placeholder={`Search ${result.view.object.pluralLabel.toLowerCase()}`}
              aria-label={`Search ${result.view.object.pluralLabel}`}
            />
            {query.sort && <input type="hidden" name="sort" value={query.sort} />}
            {query.direction && <input type="hidden" name="direction" value={query.direction} />}
            {query.mine && <input type="hidden" name="mine" value={query.mine} />}
          </form>
          {result.view.permission.canCreate && (
            <Link className="records-primary-action" href={`${base}/new`}>
              <Plus aria-hidden="true" /> New {result.view.object.label.toLowerCase()}
            </Link>
          )}
        </header>
        <RecordViewBar
          base={base}
          objectLabel={result.view.object.pluralLabel}
          query={query}
          ownerScoped={result.view.object.visibility === "owner"}
        />
        <RecordTable
          appId={result.app.appId}
          view={result.view}
          rows={result.rows}
          owners={result.owners}
          total={result.total}
          cursor={result.cursor}
          page={page}
          query={query}
        />
        <SubstrateStrip status={substrate} />
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

