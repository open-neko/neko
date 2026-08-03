export type RecordReferenceIdentity = {
  id: string;
  label: string;
  objectApiName: string;
};

export function recordReferenceIdentityKey(
  columnApiName: string,
  recordId: string,
): string {
  return `${columnApiName}\u0000${recordId}`;
}
