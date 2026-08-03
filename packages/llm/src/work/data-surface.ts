export type RecordWorkContext = {
  appId: string;
  appLabel: string;
  objectApiName: string;
  objectLabel: string;
  surface: "list" | "detail" | "recycle_list" | "recycle_detail";
  recordId?: string;
  recordLabel?: string;
  search?: string;
  myRecords?: boolean;
};

export type WorkDataSurface = "customer" | "records";

const RECORD_SURFACES = new Set<RecordWorkContext["surface"]>([
  "list",
  "detail",
  "recycle_list",
  "recycle_detail",
]);

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= 512);
}

/**
 * Validate records context at both trust boundaries: the web route before it
 * stores backend_state, and the run host before it changes the agent's tool
 * and network surface based on that state.
 */
export function parseRecordWorkContext(value: unknown): RecordWorkContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.appId !== "string" ||
    candidate.appId.length < 1 ||
    candidate.appId.length > 128 ||
    typeof candidate.appLabel !== "string" ||
    candidate.appLabel.length > 256 ||
    typeof candidate.objectApiName !== "string" ||
    candidate.objectApiName.length < 1 ||
    candidate.objectApiName.length > 128 ||
    typeof candidate.objectLabel !== "string" ||
    candidate.objectLabel.length > 256 ||
    typeof candidate.surface !== "string" ||
    !RECORD_SURFACES.has(candidate.surface as RecordWorkContext["surface"]) ||
    !optionalString(candidate.recordId) ||
    !optionalString(candidate.recordLabel) ||
    !optionalString(candidate.search) ||
    (candidate.myRecords !== undefined && typeof candidate.myRecords !== "boolean")
  ) {
    return null;
  }
  return {
    appId: candidate.appId,
    appLabel: candidate.appLabel,
    objectApiName: candidate.objectApiName,
    objectLabel: candidate.objectLabel,
    surface: candidate.surface as RecordWorkContext["surface"],
    ...(candidate.recordId !== undefined ? { recordId: candidate.recordId } : {}),
    ...(candidate.recordLabel !== undefined ? { recordLabel: candidate.recordLabel } : {}),
    ...(candidate.search !== undefined ? { search: candidate.search } : {}),
    ...(candidate.myRecords !== undefined ? { myRecords: candidate.myRecords } : {}),
  };
}
