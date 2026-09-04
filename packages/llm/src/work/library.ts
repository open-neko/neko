// Document library domain: uploaded files tracked as library_document
// rows, distilled into library_concept rows (the OKF layer), searched by
// the agent, and shared/approved into the team layer. Mirrors memory.ts
// conventions: db() per query, as-const enums, rowToX mappers, embeddings
// that never fail the write. Layering rule (same as work_memory): NULL
// user_id = team layer, visible org-wide; non-NULL = the owner's
// personal layer, visible only to them.

import {
  and,
  db,
  desc,
  eq,
  isNull,
  library_concept,
  library_document,
  library_event,
  sql,
  work_run,
  work_thread,
} from "@neko/db";
import { embedText, vectorLiteral } from "../embedding";
import type { OkfActorStamp, OkfSource } from "../library/okf";

export const LIBRARY_DOCUMENT_STATUSES = [
  "uploaded",
  "distilling",
  "cataloged",
  "skipped",
  "failed",
] as const;
export type LibraryDocumentStatus = (typeof LIBRARY_DOCUMENT_STATUSES)[number];

export const LIBRARY_CONCEPT_STATUSES = ["draft", "stable", "deprecated"] as const;
export type LibraryConceptStatus = (typeof LIBRARY_CONCEPT_STATUSES)[number];

export type LibraryDocument = {
  id: string;
  orgId: string;
  userId: string | null;
  sourceThreadId: string | null;
  filename: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
  status: LibraryDocumentStatus;
  skipReason: string | null;
  error: string | null;
  distilledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LibraryConcept = {
  id: string;
  orgId: string;
  userId: string | null;
  path: string;
  type: string;
  title: string;
  description: string | null;
  tags: string[];
  body: string;
  status: LibraryConceptStatus;
  sources: OkfSource[];
  generatedBy: string | null;
  generatedAt: string | null;
  verified: OkfActorStamp[];
  staleAfter: string | null;
  sourceDocumentId: string | null;
  promotedFromId: string | null;
  promotedBy: string | null;
  promotedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type DocumentRow = typeof library_document.$inferSelect;
type ConceptRow = typeof library_concept.$inferSelect;

export async function createLibraryDocument(input: {
  orgId: string;
  userId: string | null;
  sourceThreadId?: string | null;
  filename: string;
  relativePath: string;
  contentHash: string;
  sizeBytes: number;
}): Promise<{ document: LibraryDocument; created: boolean }> {
  // Idempotent on content: re-uploading the identical file returns the
  // existing row instead of queuing a second distillation.
  const existing = await db()
    .select()
    .from(library_document)
    .where(
      and(
        eq(library_document.org_id, input.orgId),
        userLayerCondition(library_document.user_id, input.userId),
        eq(library_document.content_hash, input.contentHash),
      ),
    )
    .limit(1);
  if (existing[0]) {
    return { document: rowToDocument(existing[0]), created: false };
  }
  const rows = await db()
    .insert(library_document)
    .values({
      org_id: input.orgId,
      user_id: input.userId,
      source_thread_id: input.sourceThreadId ?? null,
      filename: input.filename,
      relative_path: input.relativePath,
      content_hash: input.contentHash,
      size_bytes: input.sizeBytes,
    })
    .returning();
  await insertLibraryEvent({
    orgId: input.orgId,
    documentId: rows[0].id,
    userId: input.userId,
    action: "document_created",
    payload: { filename: input.filename },
  });
  return { document: rowToDocument(rows[0]), created: true };
}

export async function getLibraryDocument(
  orgId: string,
  id: string,
): Promise<LibraryDocument | null> {
  const rows = await db()
    .select()
    .from(library_document)
    .where(and(eq(library_document.org_id, orgId), eq(library_document.id, id)))
    .limit(1);
  return rows[0] ? rowToDocument(rows[0]) : null;
}

export async function listLibraryDocuments(input: {
  orgId: string;
  userId: string | null;
  limit?: number;
}): Promise<LibraryDocument[]> {
  const rows = await db()
    .select()
    .from(library_document)
    .where(
      and(
        eq(library_document.org_id, input.orgId),
        userLayerCondition(library_document.user_id, input.userId),
      ),
    )
    .orderBy(desc(library_document.created_at))
    .limit(clampLimit(input.limit ?? 100, 200));
  return rows.map(rowToDocument);
}

export async function markLibraryDocumentStatus(input: {
  orgId: string;
  id: string;
  status: LibraryDocumentStatus;
  skipReason?: string | null;
  error?: string | null;
}): Promise<void> {
  const now = new Date();
  await db()
    .update(library_document)
    .set({
      status: input.status,
      skip_reason: input.skipReason ?? null,
      error: input.error ?? null,
      distilled_at:
        input.status === "cataloged" || input.status === "skipped" ? now : null,
      updated_at: now,
    })
    .where(
      and(eq(library_document.org_id, input.orgId), eq(library_document.id, input.id)),
    );
  if (input.status !== "distilling" && input.status !== "uploaded") {
    await insertLibraryEvent({
      orgId: input.orgId,
      documentId: input.id,
      action: `document_${input.status}`,
      payload: {
        ...(input.skipReason ? { skipReason: input.skipReason } : {}),
        ...(input.error ? { error: input.error } : {}),
      },
    });
  }
}

/**
 * Resumable-distillation checkpoint: an opaque blob the librarian writes after
 * each chunk of a large document and reads back on a retry to resume from the
 * next chunk. Typed by the distiller (packages/llm/src/library/distill.ts);
 * stored here as jsonb.
 */
export async function getLibraryDistillCheckpoint(
  orgId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db()
    .select({ checkpoint: library_document.distill_checkpoint })
    .from(library_document)
    .where(and(eq(library_document.org_id, orgId), eq(library_document.id, id)))
    .limit(1);
  const cp = rows[0]?.checkpoint;
  return cp && typeof cp === "object" ? (cp as Record<string, unknown>) : null;
}

export async function saveLibraryDistillCheckpoint(
  orgId: string,
  id: string,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  await db()
    .update(library_document)
    .set({ distill_checkpoint: checkpoint, updated_at: new Date() })
    .where(and(eq(library_document.org_id, orgId), eq(library_document.id, id)));
}

export async function clearLibraryDistillCheckpoint(
  orgId: string,
  id: string,
): Promise<void> {
  await db()
    .update(library_document)
    .set({ distill_checkpoint: null, updated_at: new Date() })
    .where(and(eq(library_document.org_id, orgId), eq(library_document.id, id)));
}

/**
 * Insert or revise a concept at (org, layer, path). Updates keep the
 * row's status — a personal draft stays draft; a stable team concept
 * revised through share flows is downgraded explicitly by the caller,
 * never silently here.
 */
export async function upsertLibraryConcept(input: {
  orgId: string;
  userId: string | null;
  path: string;
  type: string;
  title: string;
  description?: string | null;
  tags?: string[];
  body: string;
  sources?: OkfSource[];
  generatedBy?: string | null;
  sourceDocumentId?: string | null;
  status?: LibraryConceptStatus;
  /** YYYY-MM-DD after which the concept is considered stale. */
  staleAfter?: string | null;
  /** Import path only: carry verification stamps from a bundle. */
  verified?: OkfActorStamp[];
}): Promise<{ concept: LibraryConcept; created: boolean }> {
  const now = new Date();
  const embedding = await tryEmbed(embeddingText(input.title, input.description, input.body));
  const existing = await findActiveConceptByPath(input.orgId, input.userId, input.path);
  if (existing) {
    const rows = await db()
      .update(library_concept)
      .set({
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        tags: input.tags ?? [],
        body: input.body,
        sources: mergeSources(existing.sources, input.sources ?? []),
        generated_by: input.generatedBy ?? existing.generatedBy,
        generated_at: now,
        source_document_id: input.sourceDocumentId ?? existing.sourceDocumentId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.staleAfter !== undefined ? { stale_after: input.staleAfter } : {}),
        ...(input.verified !== undefined ? { verified: input.verified } : {}),
        ...(embedding ? { embedding: sql`${embedding}::vector` } : {}),
        updated_at: now,
      })
      .where(
        and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, existing.id)),
      )
      .returning();
    await insertLibraryEvent({
      orgId: input.orgId,
      conceptId: existing.id,
      documentId: input.sourceDocumentId,
      userId: input.userId,
      action: "concept_updated",
      payload: { path: input.path },
    });
    return { concept: rowToConcept(rows[0]), created: false };
  }
  const rows = await db()
    .insert(library_concept)
    .values({
      org_id: input.orgId,
      user_id: input.userId,
      path: input.path,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      tags: input.tags ?? [],
      body: input.body,
      status: input.status ?? "draft",
      sources: input.sources ?? [],
      generated_by: input.generatedBy ?? null,
      generated_at: now,
      source_document_id: input.sourceDocumentId ?? null,
      stale_after: input.staleAfter ?? null,
      verified: input.verified ?? [],
      ...(embedding ? { embedding: sql`${embedding}::vector` } : {}),
    })
    .returning();
  await insertLibraryEvent({
    orgId: input.orgId,
    conceptId: rows[0].id,
    documentId: input.sourceDocumentId,
    userId: input.userId,
    action: "concept_created",
    payload: { path: input.path },
  });
  return { concept: rowToConcept(rows[0]), created: true };
}

export async function getLibraryConcept(
  orgId: string,
  id: string,
): Promise<LibraryConcept | null> {
  const rows = await db()
    .select()
    .from(library_concept)
    .where(and(eq(library_concept.org_id, orgId), eq(library_concept.id, id)))
    .limit(1);
  return rows[0] ? rowToConcept(rows[0]) : null;
}

/** List one layer: userId null = team, non-null = that member's personal. */
export async function listLibraryConcepts(input: {
  orgId: string;
  userId: string | null;
  status?: LibraryConceptStatus;
  limit?: number;
}): Promise<LibraryConcept[]> {
  const conditions = [
    eq(library_concept.org_id, input.orgId),
    userLayerCondition(library_concept.user_id, input.userId),
    isNull(library_concept.archived_at),
  ];
  if (input.status) conditions.push(eq(library_concept.status, input.status));
  const rows = await db()
    .select()
    .from(library_concept)
    .where(and(...conditions))
    .orderBy(desc(library_concept.updated_at))
    .limit(clampLimit(input.limit ?? 200, 500));
  return rows.map(rowToConcept);
}

export type LibraryConceptSearchResult = {
  concept: LibraryConcept;
  layer: "team" | "personal";
  score: number;
};

/**
 * Semantic search over the layered library: team concepts plus the
 * viewing user's personal concepts. userId comes from the caller's own
 * auth context (web) or is resolved from the run binding (agent path,
 * see searchLibraryForRun) — never from agent-supplied input.
 */
export async function searchLibraryByContext(input: {
  orgId: string;
  userId: string | null;
  query: string;
  limit?: number;
}): Promise<LibraryConceptSearchResult[]> {
  const queryVec = await tryEmbed(input.query);
  if (!queryVec) return [];
  const limit = clampLimit(input.limit ?? 5, 20);
  const layerVisible = input.userId
    ? sql`(${library_concept.user_id} IS NULL OR ${library_concept.user_id} = ${input.userId})`
    : sql`${library_concept.user_id} IS NULL`;
  const rows = await db()
    .select({
      row: library_concept,
      score: sql<number>`1 - (${library_concept.embedding} <=> ${queryVec}::vector)`,
    })
    .from(library_concept)
    .where(
      and(
        eq(library_concept.org_id, input.orgId),
        layerVisible,
        isNull(library_concept.archived_at),
        sql`${library_concept.embedding} IS NOT NULL`,
        sql`${library_concept.status} <> 'deprecated'`,
      ),
    )
    .orderBy(sql`${library_concept.embedding} <=> ${queryVec}::vector`)
    .limit(limit);
  return rows.map((r) => ({
    concept: rowToConcept(r.row),
    layer: r.row.user_id === null ? ("team" as const) : ("personal" as const),
    score: r.score,
  }));
}

/**
 * Agent-facing search: the personal layer is the run's thread owner,
 * resolved server-side from the run id (the broker strips any
 * agent-supplied userId before this is called).
 */
export async function searchLibraryForRun(input: {
  orgId: string;
  runId?: string | null;
  query: string;
  limit?: number;
}): Promise<LibraryConceptSearchResult[]> {
  const userId = input.runId
    ? await resolveRunOwnerUserId(input.orgId, input.runId)
    : null;
  return searchLibraryByContext({
    orgId: input.orgId,
    userId,
    query: input.query,
    limit: input.limit,
  });
}

async function resolveRunOwnerUserId(
  orgId: string,
  runId: string,
): Promise<string | null> {
  const rows = await db()
    .select({ owner: work_thread.created_by_user_id })
    .from(work_run)
    .innerJoin(work_thread, eq(work_run.thread_id, work_thread.id))
    .where(and(eq(work_run.org_id, orgId), eq(work_run.id, runId)))
    .limit(1);
  return rows[0]?.owner ?? null;
}

/**
 * Share a personal concept into the team layer as a draft awaiting
 * admin approval. If an active team concept already holds the path, it
 * is revised in place and downgraded to draft — re-approval is the
 * gate, matching the promote-with-lineage flow on memories.
 */
export async function shareLibraryConceptToTeam(input: {
  orgId: string;
  id: string;
  sharedBy: string | null;
}): Promise<LibraryConcept> {
  const personal = await getLibraryConcept(input.orgId, input.id);
  if (!personal || personal.archivedAt) {
    throw new Error(`Library concept not found: ${input.id}`);
  }
  if (personal.userId === null) {
    throw new Error("Concept is already in the team layer.");
  }
  const now = new Date();
  const { concept } = await upsertLibraryConcept({
    orgId: input.orgId,
    userId: null,
    path: personal.path,
    type: personal.type,
    title: personal.title,
    description: personal.description,
    tags: personal.tags,
    body: personal.body,
    sources: personal.sources,
    generatedBy: personal.generatedBy,
    sourceDocumentId: personal.sourceDocumentId,
    status: "draft",
  });
  const rows = await db()
    .update(library_concept)
    .set({
      promoted_from_id: personal.id,
      promoted_by: input.sharedBy,
      promoted_at: now,
      updated_at: now,
    })
    .where(and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, concept.id)))
    .returning();
  await insertLibraryEvent({
    orgId: input.orgId,
    conceptId: concept.id,
    userId: input.sharedBy,
    action: "shared",
    payload: { path: personal.path, fromConceptId: personal.id },
  });
  return rowToConcept(rows[0]);
}

/**
 * Admin decision on a team concept. Approve stamps a human verification
 * (OKF actor convention "human:<id>") and flips a draft to stable;
 * decline archives a draft; deprecate retires a stable concept from
 * agent search and the materialized bundle. Idempotency guards mirror
 * acceptPendingWorkMemory.
 */
export async function decideLibraryConcept(input: {
  orgId: string;
  id: string;
  action: "approve" | "decline" | "deprecate";
  decidedBy: string | null;
}): Promise<LibraryConcept> {
  const concept = await getLibraryConcept(input.orgId, input.id);
  if (!concept || concept.archivedAt) {
    throw new Error(`Library concept not found: ${input.id}`);
  }
  if (concept.userId !== null) {
    throw new Error("Only team-layer concepts go through approval.");
  }
  const now = new Date();
  const actor = input.decidedBy ?? "admin";
  const finish = async (
    set: Partial<typeof library_concept.$inferInsert>,
    action: string,
  ): Promise<LibraryConcept> => {
    const rows = await db()
      .update(library_concept)
      .set({ ...set, updated_at: now })
      .where(
        and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, input.id)),
      )
      .returning();
    await insertLibraryEvent({
      orgId: input.orgId,
      conceptId: input.id,
      userId: input.decidedBy,
      action,
      payload: { path: concept.path },
    });
    return rowToConcept(rows[0]);
  };

  if (input.action === "deprecate") {
    if (concept.status !== "stable") {
      throw new Error(`Only stable concepts can be deprecated (is ${concept.status})`);
    }
    return finish({ status: "deprecated" }, "deprecated");
  }
  if (concept.status !== "draft") {
    throw new Error(`Library concept ${input.id} already ${concept.status}`);
  }
  if (input.action === "decline") {
    return finish({ archived_at: now }, "declined");
  }
  const verified: OkfActorStamp[] = [
    ...concept.verified,
    { by: `human:${actor}`, at: now.toISOString() },
  ];
  return finish({ status: "stable", verified }, "approved");
}

/** Owner archives one of their personal concepts (team rows go through decide). */
export async function archiveLibraryConcept(input: {
  orgId: string;
  id: string;
  userId: string | null;
}): Promise<LibraryConcept> {
  const concept = await getLibraryConcept(input.orgId, input.id);
  if (!concept || concept.archivedAt || concept.userId !== input.userId) {
    throw new Error(`Library concept not found: ${input.id}`);
  }
  const now = new Date();
  const rows = await db()
    .update(library_concept)
    .set({ archived_at: now, updated_at: now })
    .where(and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, input.id)))
    .returning();
  await insertLibraryEvent({
    orgId: input.orgId,
    conceptId: input.id,
    userId: input.userId,
    action: "archived",
    payload: { path: concept.path },
  });
  return rowToConcept(rows[0]);
}

/**
 * Owner removes a document from their library: the tracking row is
 * deleted and every same-layer concept sourced from it is archived.
 * The raw file is the caller's to clean up (thread uploads belong to
 * the thread and are left alone; library-direct uploads get deleted).
 */
export async function removeLibraryDocument(input: {
  orgId: string;
  id: string;
  userId: string | null;
}): Promise<LibraryDocument> {
  const document = await getLibraryDocument(input.orgId, input.id);
  if (!document || document.userId !== input.userId) {
    throw new Error(`Library document not found: ${input.id}`);
  }
  const now = new Date();
  await db()
    .update(library_concept)
    .set({ archived_at: now, updated_at: now })
    .where(
      and(
        eq(library_concept.org_id, input.orgId),
        eq(library_concept.source_document_id, input.id),
        userLayerCondition(library_concept.user_id, input.userId),
        isNull(library_concept.archived_at),
      ),
    );
  await db()
    .delete(library_document)
    .where(
      and(eq(library_document.org_id, input.orgId), eq(library_document.id, input.id)),
    );
  await insertLibraryEvent({
    orgId: input.orgId,
    userId: input.userId,
    action: "document_removed",
    payload: { filename: document.filename },
  });
  return document;
}

// Best-effort audit insert, mirroring insertWorkMemoryEvent — a logging
// failure never fails the write it describes.
export async function insertLibraryEvent(input: {
  orgId: string;
  documentId?: string | null;
  conceptId?: string | null;
  userId?: string | null;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db().insert(library_event).values({
      org_id: input.orgId,
      document_id: input.documentId ?? null,
      concept_id: input.conceptId ?? null,
      user_id: input.userId ?? null,
      action: input.action,
      payload: input.payload ?? {},
    });
  } catch (err) {
    console.warn(
      `[library] event insert failed (write succeeded): ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Nightly staleness sweep: stable concepts past their stale_after date
 * become deprecated — still stored and searchable in the UI, but
 * excluded from agent search and the materialized team bundle. Returns
 * the org ids that changed so callers can re-materialize their bundles.
 */
export async function sweepStaleLibraryConcepts(): Promise<{
  deprecated: number;
  orgIds: string[];
}> {
  const rows = await db()
    .update(library_concept)
    .set({ status: "deprecated", updated_at: new Date() })
    .where(
      and(
        eq(library_concept.status, "stable"),
        isNull(library_concept.archived_at),
        sql`${library_concept.stale_after} IS NOT NULL`,
        sql`${library_concept.stale_after} < CURRENT_DATE`,
      ),
    )
    .returning({ id: library_concept.id, org_id: library_concept.org_id });
  for (const row of rows) {
    await insertLibraryEvent({
      orgId: row.org_id,
      conceptId: row.id,
      action: "deprecated",
      payload: { reason: "stale_after elapsed" },
    });
  }
  return {
    deprecated: rows.length,
    orgIds: [...new Set(rows.map((r) => r.org_id))],
  };
}

async function findActiveConceptByPath(
  orgId: string,
  userId: string | null,
  path: string,
): Promise<LibraryConcept | null> {
  const rows = await db()
    .select()
    .from(library_concept)
    .where(
      and(
        eq(library_concept.org_id, orgId),
        userLayerCondition(library_concept.user_id, userId),
        eq(library_concept.path, path),
        isNull(library_concept.archived_at),
      ),
    )
    .limit(1);
  return rows[0] ? rowToConcept(rows[0]) : null;
}

function userLayerCondition(
  column: typeof library_concept.user_id | typeof library_document.user_id,
  userId: string | null,
) {
  return userId === null ? isNull(column) : eq(column, userId);
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function embeddingText(
  title: string,
  description: string | null | undefined,
  body: string,
): string {
  return [title, description ?? "", body].join("\n").slice(0, 4000);
}

function mergeSources(existing: OkfSource[], incoming: OkfSource[]): OkfSource[] {
  const byResource = new Map<string, OkfSource>();
  for (const source of [...existing, ...incoming]) {
    if (source?.resource) byResource.set(source.resource, source);
  }
  return Array.from(byResource.values());
}

async function tryEmbed(text: string): Promise<string | null> {
  try {
    return vectorLiteral(await embedText(text));
  } catch (err) {
    console.error(
      "[library] embedding failed; storing concept without vector:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function rowToDocument(row: DocumentRow): LibraryDocument {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    sourceThreadId: row.source_thread_id,
    filename: row.filename,
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    status: row.status as LibraryDocumentStatus,
    skipReason: row.skip_reason,
    error: row.error,
    distilledAt: row.distilled_at ? row.distilled_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function rowToConcept(row: ConceptRow): LibraryConcept {
  return {
    id: row.id,
    orgId: row.org_id,
    userId: row.user_id,
    path: row.path,
    type: row.type,
    title: row.title,
    description: row.description,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    body: row.body,
    status: row.status as LibraryConceptStatus,
    sources: Array.isArray(row.sources) ? (row.sources as OkfSource[]) : [],
    generatedBy: row.generated_by,
    generatedAt: row.generated_at ? row.generated_at.toISOString() : null,
    verified: Array.isArray(row.verified) ? (row.verified as OkfActorStamp[]) : [],
    staleAfter: row.stale_after,
    sourceDocumentId: row.source_document_id,
    promotedFromId: row.promoted_from_id,
    promotedBy: row.promoted_by,
    promotedAt: row.promoted_at ? row.promoted_at.toISOString() : null,
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
