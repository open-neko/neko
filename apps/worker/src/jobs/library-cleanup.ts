import {
  clearLibraryTransientCleanupCandidates,
  listLibraryTransientCleanupCandidates,
  removeLibraryDerivedMarkdown,
} from "@neko/llm";

const FAILED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Finish cleanup after successful jobs immediately, and remove forensic
 * extraction/checkpoint state retained for failed jobs after seven days.
 */
export async function sweepExpiredLibraryTransientState(
  now: Date = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - FAILED_RETENTION_MS);
  const entries = await listLibraryTransientCleanupCandidates(before);
  const cleared = [];
  for (const entry of entries) {
    try {
      await removeLibraryDerivedMarkdown(
        entry.orgId,
        entry.extractedRelativePath,
      );
      cleared.push(entry);
    } catch (error) {
      console.warn(
        `[library-cleanup] document ${entry.documentId} retained: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  await clearLibraryTransientCleanupCandidates(cleared);
  return cleared.length;
}
