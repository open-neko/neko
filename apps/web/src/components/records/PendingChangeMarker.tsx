import Link from "next/link";
import type { PendingRecordAction } from "@/lib/records-pending";

export function PendingChangeMarker({
  actions,
}: {
  actions: PendingRecordAction[];
}) {
  const first = actions[0];
  if (!first) return null;
  const count = actions.length;
  return (
    <Link
      className="records-pending-marker"
      href={`/actions/${first.id}`}
      title={first.summary ?? "Open the pending record change"}
    >
      <span aria-hidden="true" />
      {count === 1 ? "Pending change" : `${count} pending changes`}
    </Link>
  );
}
