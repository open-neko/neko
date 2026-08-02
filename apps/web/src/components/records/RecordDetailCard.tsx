import type { RecordObjectView } from "@neko/records";
import type { RecordOwnerIdentity } from "@/lib/records";
import { RecordCell } from "./RecordCell";

export function RecordDetailCard({
  appId,
  view,
  row,
  owners,
}: {
  appId: string;
  view: RecordObjectView;
  row: Record<string, unknown>;
  owners: Record<string, RecordOwnerIdentity>;
}) {
  const ownerId =
    typeof row.owner_user_id === "string" ? row.owner_user_id : null;
  return (
    <section className="records-detail-card">
      <dl className="records-detail-grid">
        {view.columns.map((column) => (
          <div className="records-detail-field" key={column.apiName}>
            <dt>{column.label}</dt>
            <dd>
              <RecordCell
                appId={appId}
                column={column}
                value={row[column.columnName]}
                owner={
                  column.kind === "owner" && ownerId
                    ? owners[ownerId]
                    : undefined
                }
              />
            </dd>
          </div>
        ))}
      </dl>
      <footer className="records-detail-id">
        <span>Record ID</span>
        <code>{String(row.id)}</code>
      </footer>
    </section>
  );
}
