import Link from "next/link";
import type {
  RecordFilterExpression,
  RecordSavedView,
  RecordSavedViewDefinition,
} from "@neko/records";
import {
  RecordFilterBuilder,
  type RecordFilterField,
} from "./RecordFilterBuilder";

function hrefWith(base: string, current: Record<string, string | undefined>, mine: boolean) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value !== undefined && key !== "after" && key !== "page") params.set(key, value);
  }
  if (mine) params.set("mine", "true");
  else params.set("mine", "false");
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function RecordViewBar({
  base,
  objectLabel,
  query,
  ownerScoped,
  appId,
  objectApiName,
  views,
  selectedView,
  definition,
  fields,
  canShare,
}: {
  base: string;
  objectLabel: string;
  query: Record<string, string | undefined>;
  ownerScoped: boolean;
  appId: string;
  objectApiName: string;
  views: RecordSavedView[];
  selectedView: RecordSavedView | null;
  definition: RecordSavedViewDefinition;
  fields: RecordFilterField[];
  canShare: boolean;
}) {
  const mine = query.mine === "true";
  const endpoint = `/api/a/${encodeURIComponent(appId)}/${encodeURIComponent(objectApiName)}/views`;
  const activeFilter = definition.filter;
  return (
    <div className="records-viewbar">
      <form className="records-view-picker" action={base} method="get">
        <label className="sr-only" htmlFor="records-saved-view">Saved view</label>
        <select id="records-saved-view" name="view" defaultValue={selectedView?.id ?? ""}>
          <option value="">All {objectLabel.toLowerCase()}</option>
          {views.map((view) => (
            <option value={view.id} key={view.id}>
              {view.label}{view.shared ? " · shared" : ""}
            </option>
          ))}
        </select>
        <button type="submit">Open</button>
      </form>
      {query.q && (
        <span className="records-filter-chip">
          Name contains <b>{query.q}</b>
          <Link href={hrefWith(base, { ...query, q: "" }, mine)} aria-label="Clear search">
            ×
          </Link>
        </span>
      )}
      {activeFilter && (
        <span className="records-filter-chip">
          {filterCount(activeFilter)} active {filterCount(activeFilter) === 1 ? "filter" : "filters"}
          <Link
            href={hrefWith(base, { ...query, filter: "null" }, mine)}
            aria-label="Clear all filters"
          >
            ×
          </Link>
        </span>
      )}
      <RecordFilterBuilder base={base} query={query} fields={fields} />
      <details className="records-view-save">
        <summary>Save view</summary>
        <form action={endpoint} method="post">
          <label>
            Name
            <input name="label" required maxLength={80} defaultValue={selectedView?.label} />
          </label>
          <input type="hidden" name="definition" value={JSON.stringify(definition)} />
          {canShare && (
            <label className="records-view-share">
              <input name="shared" type="checkbox" value="true" defaultChecked={selectedView?.shared} />
              Share with this organization
            </label>
          )}
          <button type="submit">Save</button>
        </form>
      </details>
      {selectedView && (!selectedView.shared || canShare) && (
        <form action={`${endpoint}/${selectedView.id}`} method="post">
          <button className="records-view-delete" type="submit" aria-label={`Delete ${selectedView.label}`}>
            Delete view
          </button>
        </form>
      )}
      {ownerScoped && (
        <Link
          href={hrefWith(base, query, !mine)}
          className="records-scope-toggle"
          role="switch"
          aria-checked={mine}
        >
          My records
          <span className={`records-switch${mine ? " is-on" : ""}`} aria-hidden="true">
            <span />
          </span>
        </Link>
      )}
    </div>
  );
}

function filterCount(expression: RecordFilterExpression): number {
  return "op" in expression
    ? expression.clauses.reduce((total, clause) => total + filterCount(clause), 0)
    : 1;
}
