export const PENDING_RECORD_ACTION_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
] as const;

export type PendingRecordAction = {
  id: string;
  kind: "record_update" | "record_delete" | "record_restore";
  status: (typeof PENDING_RECORD_ACTION_STATUSES)[number];
  summary: string | null;
  fields: Record<string, unknown> | null;
  expected: Record<string, unknown> | null;
  createdAt: string;
};

type PendingActionRow = {
  id: string;
  kind: string;
  status: string;
  summary: string | null;
  payload: unknown;
  createdAt: Date | string;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isPendingRecordActionStatus(
  status: string,
): status is PendingRecordAction["status"] {
  return (PENDING_RECORD_ACTION_STATUSES as readonly string[]).includes(status);
}

export function groupPendingRecordActions(input: {
  rows: PendingActionRow[];
  appId: string;
  objectApiName: string;
  recordIds: string[];
}): Record<string, PendingRecordAction[]> {
  const recordIds = new Set(input.recordIds);
  const grouped: Record<string, PendingRecordAction[]> = {};
  for (const row of input.rows) {
    if (!isPendingRecordActionStatus(row.status)) continue;
    if (
      row.kind !== "record_update" &&
      row.kind !== "record_delete" &&
      row.kind !== "record_restore"
    ) continue;
    const payload = objectValue(row.payload);
    if (
      payload?.app !== input.appId ||
      payload.object !== input.objectApiName ||
      typeof payload.id !== "string" ||
      !recordIds.has(payload.id)
    ) continue;
    const action: PendingRecordAction = {
      id: row.id,
      kind: row.kind,
      status: row.status,
      summary: row.summary,
      fields: objectValue(payload.fields),
      expected: objectValue(payload.expected),
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
    };
    (grouped[payload.id] ??= []).push(action);
  }
  return grouped;
}
