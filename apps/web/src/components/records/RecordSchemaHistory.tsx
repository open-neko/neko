import type { RecordSchemaHistoryEntry } from "@/lib/records";

function summary(detail: Record<string, unknown>): string[] {
  const preview = detail.preview;
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    const effects = (preview as Record<string, unknown>).effects;
    if (Array.isArray(effects)) {
      return effects.filter((effect): effect is string => typeof effect === "string").slice(0, 5);
    }
  }
  const phase = typeof detail.sagaPhase === "string" ? `Saga phase: ${detail.sagaPhase}` : null;
  return phase ? [phase] : ["Registry definition updated"];
}

export function RecordSchemaHistory({ history }: { history: RecordSchemaHistoryEntry[] }) {
  return (
    <section className="records-admin-panel records-schema-history">
      <header><div><h2>Schema history</h2><p>Approved registry changes, newest first. Executable DDL is deliberately not exposed here.</p></div></header>
      {history.length === 0 ? (
        <p className="records-admin-empty">No schema changes have been recorded.</p>
      ) : (
        <ol>
          {history.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong>{entry.action.replaceAll("_", " ")}</strong>
                <time dateTime={entry.at}>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.at))}</time>
                <span>{entry.actorUserId ?? "System"}</span>
              </div>
              <ul>{summary(entry.detail).map((effect) => <li key={effect}>{effect}</li>)}</ul>
              {entry.actionRequestId && <code>{entry.actionRequestId}</code>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
