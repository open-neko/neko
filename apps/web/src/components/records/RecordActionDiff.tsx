import { cn } from "@/lib/cn";

type RecordActionPayload = {
  app: string;
  object: string;
  id: string;
  fields: Record<string, unknown>;
  expected: Record<string, unknown> | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseRecordUpdatePayload(
  kind: string | undefined,
  value: unknown,
): RecordActionPayload | null {
  if (kind !== "record_update") return null;
  const payload = objectValue(value);
  const fields = objectValue(payload?.fields);
  if (
    !payload ||
    typeof payload.app !== "string" ||
    typeof payload.object !== "string" ||
    typeof payload.id !== "string" ||
    !fields ||
    Object.keys(fields).length === 0
  ) return null;
  return {
    app: payload.app,
    object: payload.object,
    id: payload.id,
    fields,
    expected: objectValue(payload.expected),
  };
}

function displayValue(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === null) return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value || "Empty";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function RecordActionDiff({
  kind,
  payload,
  compact = false,
}: {
  kind?: string;
  payload: unknown;
  compact?: boolean;
}) {
  const parsed = parseRecordUpdatePayload(kind, payload);
  if (!parsed) return null;
  return (
    <div
      className={cn("record-action-diff", compact && "is-compact")}
      aria-label="Proposed record changes"
    >
      {!compact && (
        <div className="record-action-diff-target">
          <span>Record</span>
          <code>{parsed.app} / {parsed.object} / {parsed.id}</code>
        </div>
      )}
      <dl>
        {Object.entries(parsed.fields).map(([field, next]) => (
          <div key={field}>
            <dt>{field.replace(/_/g, " ")}</dt>
            <dd>
              <span className="record-action-diff-old">
                {displayValue(parsed.expected?.[field], "Current value")}
              </span>
              <span className="record-action-diff-arrow" aria-hidden="true">→</span>
              <strong>{displayValue(next, "Empty")}</strong>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
