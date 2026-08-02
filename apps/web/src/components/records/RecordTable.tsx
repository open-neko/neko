import Link from "next/link";
import type { RecordObjectView } from "@neko/records";
import type { RecordOwnerIdentity } from "@/lib/records";
import { RecordCell } from "./RecordCell";

function hrefWith(
  base: string,
  current: Record<string, string | undefined>,
  changes: Record<string, string | null>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) {
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function RecordTable({
  appId,
  view,
  rows,
  owners,
  total,
  cursor,
  page,
  query,
}: {
  appId: string;
  view: RecordObjectView;
  rows: Array<Record<string, unknown>>;
  owners: Record<string, RecordOwnerIdentity>;
  total: number;
  cursor: string | null;
  page: number;
  query: Record<string, string | undefined>;
}) {
  const base = `/a/${appId}/${view.object.apiName}`;
  const shownThrough = (page - 1) * 50 + rows.length;
  const hasMore = cursor !== null && shownThrough < total;
  return (
    <section className="records-list-card" aria-label={`${view.object.pluralLabel} records`}>
      <div className="records-table-scroll">
        <table className="records-table">
          <thead>
            <tr>
              {view.columns.map((column) => {
                const active = query.sort === column.apiName;
                const direction = active && query.direction === "desc" ? "asc" : "desc";
                const sortable = column.kind !== "owner" && column.kind !== "system_datetime";
                return (
                  <th
                    key={column.apiName}
                    className={["integer", "decimal", "currency", "percent"].includes(column.kind) ? "is-number" : undefined}
                  >
                    {sortable ? (
                      <Link
                        href={hrefWith(base, query, {
                          sort: column.apiName,
                          direction,
                          after: null,
                          page: null,
                        })}
                      >
                        {column.label}
                        {active && <span aria-hidden="true"> {query.direction === "desc" ? "↓" : "↑"}</span>}
                      </Link>
                    ) : (
                      column.label
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const recordId = String(row.id ?? "");
              return (
                <tr key={recordId || `row-${rowIndex}`}>
                  {view.columns.map((column) => {
                    const value = row[column.columnName];
                    const ownerId = column.kind === "owner" && typeof value === "string" ? value : null;
                    const nameColumn = column.columnName === view.object.nameField;
                    const content = (
                      <RecordCell
                        appId={appId}
                        column={column}
                        value={value}
                        owner={ownerId ? owners[ownerId] : undefined}
                        linkify={!nameColumn}
                      />
                    );
                    return (
                      <td
                        key={column.apiName}
                        className={["integer", "decimal", "currency", "percent"].includes(column.kind) ? "is-number" : undefined}
                      >
                        {nameColumn && recordId ? (
                          <Link className="records-name-link" href={`${base}/${encodeURIComponent(recordId)}`}>
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <div className="records-empty">
          <strong>No matching {view.object.pluralLabel.toLowerCase()}</strong>
          <span>Change the current search or create the first record.</span>
        </div>
      )}
      <footer className="records-list-foot">
        <span>
          {total === 0 ? "No records" : `Showing ${(page - 1) * 50 + 1}–${shownThrough} of ${total}`}
        </span>
        {hasMore && (
          <Link
            className="records-page-button"
            href={hrefWith(base, query, {
              after: cursor,
              page: String(page + 1),
            })}
          >
            Next page <span aria-hidden="true">→</span>
          </Link>
        )}
      </footer>
    </section>
  );
}
