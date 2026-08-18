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
        ...(embedding ? { embedding: sql`${embedding}::vector` } : {}),
        updated_at: now,
      })
      .where(
        and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, existing.id)),
      )
      .returning();
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
      ...(embedding ? { embedding: sql`${embedding}::vector` } : {}),
    })
    .returning();
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
  return rowToConcept(rows[0]);
}

/**
 * Admin decision on a team draft. Approve stamps a human verification
 * (OKF actor convention "human:<id>") and flips to stable; decline
 * archives the draft. Idempotency guard mirrors acceptPendingWorkMemory.
 */
export async function decideLibraryConcept(input: {
  orgId: string;
  id: string;
  action: "approve" | "decline";
  decidedBy: string | null;
}): Promise<LibraryConcept> {
  const concept = await getLibraryConcept(input.orgId, input.id);
  if (!concept || concept.archivedAt) {
    throw new Error(`Library concept not found: ${input.id}`);
  }
  if (concept.userId !== null) {
    throw new Error("Only team-layer concepts go through approval.");
  }
  if (concept.status !== "draft") {
    throw new Error(`Library concept ${input.id} already ${concept.status}`);
  }
  const now = new Date();
  if (input.action === "decline") {
    const rows = await db()
      .update(library_concept)
      .set({ archived_at: now, updated_at: now })
      .where(and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, input.id)))
      .returning();
    return rowToConcept(rows[0]);
  }
  const verified: OkfActorStamp[] = [
    ...concept.verified,
    { by: `human:${input.decidedBy ?? "admin"}`, at: now.toISOString() },
  ];
  const rows = await db()
    .update(library_concept)
    .set({ status: "stable", verified, updated_at: now })
    .where(and(eq(library_concept.org_id, input.orgId), eq(library_concept.id, input.id)))
    .returning();
  return rowToConcept(rows[0]);
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
