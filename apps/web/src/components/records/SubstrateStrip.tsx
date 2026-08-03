import { CircleCheck, CircleAlert, RefreshCw, Users } from "lucide-react";
import type { JsonObject } from "@neko/records";

export function SubstrateStrip({
  status,
}: {
  status: {
    availability: "active" | "degraded";
    reason: string | null;
    config: JsonObject;
    unlinkedIdentities: number;
    latestSync: { watermark: unknown; updatedAt: string } | null;
  };
}) {
  const revision = status.config.registryRevision;
  const imported = status.config.import;
  return (
    <aside className="records-substrate" aria-label="Records substrate status">
      <span className="records-substrate-item">
        {status.availability === "active" ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
        <span>
          <b>Data plane</b>
          {status.availability === "active" ? "Healthy" : "Degraded"}
        </span>
      </span>
      <span className="records-substrate-item">
        <RefreshCw aria-hidden="true" />
        <span>
          <b>{imported ? "Source sync" : "Registry"}</b>
          {status.latestSync
            ? `Updated ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.latestSync.updatedAt))}`
            : revision
              ? `Revision ${String(revision)}`
              : "Ready"}
        </span>
      </span>
      <span className="records-substrate-item">
        <Users aria-hidden="true" />
        <span>
          <b>Identity</b>
          {status.unlinkedIdentities === 0
            ? "All linked"
            : `${status.unlinkedIdentities} need review`}
        </span>
      </span>
    </aside>
  );
}

