import type { LibraryDistillPayload } from "@neko/db/jobs";
import { runLibraryDistill } from "@neko/llm";

/**
 * library_distill job handler: run the librarian over one uploaded
 * document, writing OKF concepts onto the uploader's personal layer.
 * Status transitions (distilling → cataloged | skipped | failed) live on
 * the library_document row, so the web UI polls the DB, not pg-boss.
 * runLibraryDistill records failures on the row and resolves — a throw
 * here means we never reached the row, and pg-boss retry is the right
 * response.
 */
export async function runLibraryDistillJob(
  payload: LibraryDistillPayload,
): Promise<void> {
  const result = await runLibraryDistill({
    orgId: payload.orgId,
    documentId: payload.documentId,
    force: payload.force === true,
  });
  console.log(
    `[library_distill] document ${payload.documentId} → ${result.status}` +
      (result.reason ? ` (${result.reason})` : "") +
      (result.concepts.length > 0 ? `, ${result.concepts.length} concept(s)` : ""),
  );
}
