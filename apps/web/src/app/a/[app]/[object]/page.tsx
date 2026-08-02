import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus, Search, Upload } from "lucide-react";
import { getCurrentActor } from "@/lib/actor";
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

async function loadPage(input: {
  orgId: string;
  app: string;
  object: string;
  queryParams: SearchParams;
}) {
  const shell = await loadRecordAppShell(input.orgId, input.app);
  if (shell.availability === "degraded") {
    return {
      kind: "degraded" as const,
      message: shell.degradedReason ?? "The app is degraded.",
    };
  }
  const direction = value(input.queryParams, "direction") === "desc" ? "desc" : "asc";
  const sortField = value(input.queryParams, "sort");
  const page = positivePage(value(input.queryParams, "page"));
  const [result, substrate, actor] = await Promise.all([
    readRecordList({
      orgId: input.orgId,
      appId: input.app,
      objectApiName: input.object,
      first: 50,
      after: value(input.queryParams, "after"),
      search: value(input.queryParams, "q"),
      sort: sortField ? { field: sortField, direction } : undefined,
      myRecords: value(input.queryParams, "mine") === "true",
    }),
    getRecordSubstrateStatus({ orgId: input.orgId, appId: input.app }),
    getCurrentActor(),
  ]);
  return {
    kind: "active" as const,
    result,
    substrate,
    actor,
    page,
    base: `/a/${result.app.appId}/${result.view.object.apiName}`,
    query: {
      q: value(input.queryParams, "q"),
      sort: sortField,
      direction: value(input.queryParams, "direction"),
      mine: value(input.queryParams, "mine"),
      after: value(input.queryParams, "after"),
      page: value(input.queryParams, "page"),
    },
  };
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
  let loaded: Awaited<ReturnType<typeof loadPage>> | null = null;
  let routeError: RecordAppRouteError | null = null;
  try {
    loaded = await loadPage({ orgId, app, object, queryParams });
  } catch (error) {
    if (error instanceof RecordAppRouteError) {
      routeError = error;
    } else {
      throw error;
    }
  }

  if (routeError?.status === 404) notFound();
  if (routeError) return <RecordsUnavailable message={routeError.message} />;
  if (!loaded) throw new Error("Record page did not resolve.");
  if (loaded.kind === "degraded") return <RecordsUnavailable message={loaded.message} />;

  const { result, substrate, actor, page, base, query } = loaded;
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
        {actor.role === "admin" && (
          <Link
            className="records-secondary-action"
            href={`/a/${result.app.appId}/admin?object=${encodeURIComponent(result.view.object.apiName)}`}
          >
            <Upload aria-hidden="true" /> Import
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
}
