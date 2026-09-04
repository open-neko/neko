import { randomUUID } from "node:crypto";
import { enqueue, QUEUE, type LibraryExtractPayload } from "@neko/db/jobs";
import { listStaleUploadedLibraryDocuments } from "@neko/llm";

const UPLOAD_QUEUE_GRACE_MS = 5 * 60 * 1_000;

type RecoveryDependencies = {
  list: typeof listStaleUploadedLibraryDocuments;
  enqueue: typeof enqueue;
};

const defaultDependencies: RecoveryDependencies = {
  list: listStaleUploadedLibraryDocuments,
  enqueue,
};

/** Recover the narrow committed-upload-before-queue-send failure window. */
export async function recoverUnqueuedLibraryUploads(
  now: Date = new Date(),
  overrides: Partial<RecoveryDependencies> = {},
): Promise<number> {
  const deps = { ...defaultDependencies, ...overrides };
  const documents = await deps.list(
    new Date(now.getTime() - UPLOAD_QUEUE_GRACE_MS),
  );
  let enqueued = 0;
  for (const document of documents) {
    const payload: LibraryExtractPayload = {
      orgId: document.orgId,
      documentId: document.documentId,
      runId: randomUUID(),
      sequence: 0,
    };
    const jobId = await deps.enqueue(QUEUE.LIBRARY_EXTRACT, payload, {
      retryLimit: 8,
      retryDelay: 15,
      retryBackoff: true,
      singletonKey: `library-extract:${document.documentId}`,
    });
    if (jobId) enqueued += 1;
  }
  return enqueued;
}
