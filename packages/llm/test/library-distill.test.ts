import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryConcept, LibraryDocument } from "../src/work/library";

// In-memory stand-ins for the DB-backed domain layer so the distiller's
// orchestration logic is testable without Postgres or a model provider.
const state: {
  document: LibraryDocument | null;
  statuses: Array<{ status: string; skipReason?: string | null; error?: string | null }>;
  upserts: Array<Record<string, unknown>>;
  catalog: LibraryConcept[];
  checkpoint: Record<string, unknown> | null;
} = { document: null, statuses: [], upserts: [], catalog: [], checkpoint: null };

let workspaceRoot = "";

vi.mock("../src/work/library", () => ({
  getLibraryDocument: vi.fn(async () => state.document),
  listLibraryConcepts: vi.fn(async () => state.catalog),
  markLibraryDocumentStatus: vi.fn(async (input: Record<string, unknown>) => {
    state.statuses.push({
      status: String(input.status),
      skipReason: (input.skipReason as string | null) ?? null,
      error: (input.error as string | null) ?? null,
    });
  }),
  upsertLibraryConcept: vi.fn(async (input: Record<string, unknown>) => {
    state.upserts.push(input);
    return { concept: { id: `c-${state.upserts.length}`, ...input }, created: true };
  }),
  getLibraryDistillCheckpoint: vi.fn(async () => state.checkpoint),
  saveLibraryDistillCheckpoint: vi.fn(
    async (_org: string, _id: string, cp: Record<string, unknown>) => {
      state.checkpoint = cp;
    },
  ),
  clearLibraryDistillCheckpoint: vi.fn(async () => {
    state.checkpoint = null;
  }),
}));

vi.mock("../src/work/workspace", () => ({
  getOrgAgentRoot: vi.fn(() => workspaceRoot),
}));

import { mergeUpsertOps, runLibraryDistill, type DistillExtract } from "../src/library/distill";
import { sliceMarkdownSections } from "../src/library/extract";
import type { LibraryUpsertOp } from "../src/library/fence";

// Stand-in for the librarian service: read the workspace file directly so the
// distiller's orchestration is testable without the extraction service. Tests
// that exercise extraction failure inject their own stub instead.
const readExtract: DistillExtract = async ({ absolutePath }) => ({
  ok: true,
  text: await readFile(absolutePath, "utf8"),
  structure: { format: "markdown", sections: [] },
});

const ORG = "org-1";

function document(overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return {
    id: "doc-1",
    orgId: ORG,
    userId: "user-1",
    sourceThreadId: "thread-1",
    filename: "refund-policy.md",
    relativePath: "uploads/thread-1/refund-policy.md",
    contentHash: "hash",
    sizeBytes: 512,
    status: "uploaded",
    skipReason: null,
    error: null,
    distilledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const POLICY_TEXT = [
  "# Refund policy",
  "",
  "Customers may request refunds within 30 days of purchase.",
  "Refunds above five hundred dollars require CFO approval.",
].join("\n");

const fence = (ops: unknown[]): string =>
  ["```neko_library", JSON.stringify(ops), "```"].join("\n");

const outlineFence = (distill: number[]): string =>
  ["```neko_outline", JSON.stringify({ distill }), "```"].join("\n");

const FENCE_REPLY = [
  "Cataloged.",
  fence([
    {
      op: "upsert",
      path: "policies/refund-policy.md",
      type: "Policy",
      title: "Refund policy",
      description: "Refund windows and approval limits.",
      tags: ["finance"],
      body: "Refunds within 30 days; >$500 needs CFO approval.",
    },
  ]),
].join("\n");

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "neko-library-distill-"));
  state.document = document();
  state.statuses = [];
  state.upserts = [];
  state.catalog = [];
  state.checkpoint = null;
  await mkdir(join(workspaceRoot, "uploads", "thread-1"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "uploads", "thread-1", "refund-policy.md"),
    POLICY_TEXT,
    "utf8",
  );
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("runLibraryDistill", () => {
  it("catalogs a knowledge document onto the uploader's personal layer", async () => {
    const llm = vi.fn(async () => FENCE_REPLY);
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm, extract: readExtract });

    expect(result.status).toBe("cataloged");
    expect(result.concepts).toHaveLength(1);
    expect(state.statuses.map((s) => s.status)).toEqual(["distilling", "cataloged"]);
    expect(state.upserts[0]).toMatchObject({
      orgId: ORG,
      userId: "user-1",
      path: "policies/refund-policy.md",
      type: "Policy",
      sourceDocumentId: "doc-1",
    });
    expect(state.upserts[0].sources).toEqual([
      expect.objectContaining({
        resource: "/uploads/thread-1/refund-policy.md",
      }),
    ]);
    expect(String(state.upserts[0].generatedBy)).toMatch(/^openneko\//);
    expect(llm).toHaveBeenCalledOnce();
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("refund-policy.md");
    expect(prompt).toContain("Customers may request refunds");
    expect(prompt).toContain('"op": "upsert"');
    expect(prompt).toContain('"op": "skip"');
    expect(prompt).toContain("Use exactly these JSON object shapes");
  });

  it("passes the existing catalog so the librarian updates instead of duplicating", async () => {
    state.catalog = [
      {
        path: "policies/refund-policy.md",
        title: "Refund policy",
        description: "Old summary",
      } as LibraryConcept,
    ];
    const llm = vi.fn(async () => FENCE_REPLY);
    await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm, extract: readExtract });
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("- policies/refund-policy.md — Refund policy: Old summary");
  });

  it("skips when the librarian emits a skip op", async () => {
    const llm = vi.fn(async () =>
      "```neko_library\n" +
        JSON.stringify([{ skip: { reason: "one-off working data" } }]) +
        "\n```",
    );
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm, extract: readExtract });
    expect(result.status).toBe("skipped");
    expect(state.statuses.at(-1)).toMatchObject({
      status: "skipped",
      skipReason: "one-off working data",
    });
    expect(state.upserts).toHaveLength(0);
  });

  it("skips data-shaped files at triage without calling the model", async () => {
    state.document = document({
      filename: "orders.csv",
      relativePath: "uploads/thread-1/orders.csv",
      sizeBytes: 2_000_000,
    });
    await writeFile(
      join(workspaceRoot, "uploads", "thread-1", "orders.csv"),
      "order_id,total\n1,2\n",
      "utf8",
    );
    const llm = vi.fn(async () => FENCE_REPLY);
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm, extract: readExtract });
    expect(result.status).toBe("skipped");
    expect(llm).not.toHaveBeenCalled();
  });

  it("fails cleanly when extraction reports a failure", async () => {
    state.document = document({
      filename: "contract.pdf",
      relativePath: "uploads/thread-1/contract.pdf",
    });
    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm: vi.fn(async () => FENCE_REPLY),
      extract: async () => ({ ok: false, reason: "no extraction tool installed" }),
    });
    expect(result.status).toBe("failed");
    expect(state.statuses.at(-1)?.error).toBe("no extraction tool installed");
  });

  it("fails when the reply has no parseable ops", async () => {
    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm: vi.fn(async () => "I could not process this."),
      extract: readExtract,
    });
    expect(result.status).toBe("failed");
    expect(state.statuses.at(-1)?.error).toContain("no parseable");
  });

  it("refuses upload paths that escape the org workspace", async () => {
    state.document = document({ relativePath: "../../etc/passwd" });
    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm: vi.fn(async () => FENCE_REPLY),
    });
    expect(result.status).toBe("failed");
    expect(state.statuses.at(-1)?.error).toContain("escapes");
  });

  it("is idempotent for already-cataloged documents", async () => {
    state.document = document({ status: "cataloged" });
    const llm = vi.fn(async () => FENCE_REPLY);
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm, extract: readExtract });
    expect(result.status).toBe("cataloged");
    expect(state.statuses).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it("chunks a large document and merges concepts across parts by path", async () => {
    const bigText = `# Alpha\n${"a".repeat(30_000)}\n# Beta\n${"b".repeat(30_000)}`;
    const bigExtract: DistillExtract = async () => ({
      ok: true,
      text: bigText,
      structure: { format: "markdown", sections: sliceMarkdownSections(bigText) },
    });
    const llm = vi
      .fn()
      // Call 1: the outline pass selects both sections.
      .mockResolvedValueOnce(outlineFence([0, 1]))
      .mockResolvedValueOnce(
        fence([
          {
            op: "upsert",
            path: "policies/alpha.md",
            type: "Policy",
            title: "Alpha",
            tags: ["x"],
            body: "Alpha part one.",
          },
        ]),
      )
      .mockResolvedValueOnce(
        fence([
          {
            op: "upsert",
            path: "policies/alpha.md",
            type: "Policy",
            title: "Alpha",
            tags: ["y"],
            body: "Alpha part two.",
          },
          {
            op: "upsert",
            path: "policies/beta.md",
            type: "Policy",
            title: "Beta",
            body: "Beta stuff.",
          },
        ]),
      );

    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm,
      extract: bigExtract,
    });

    expect(result.status).toBe("cataloged");
    // Outline pass + two chunk passes.
    expect(llm).toHaveBeenCalledTimes(3);
    expect(llm.mock.calls[0][0] as string).toContain("Select the sections");
    // Reduce-by-path: alpha (seen twice) merged into one, plus beta.
    expect(state.upserts).toHaveLength(2);
    const alpha = state.upserts.find((u) => u.path === "policies/alpha.md");
    expect(alpha?.body).toContain("Alpha part one.");
    expect(alpha?.body).toContain("Alpha part two.");
    expect(alpha?.tags).toEqual(expect.arrayContaining(["x", "y"]));
    // Part 2 is told about the concept already extracted in part 1.
    expect(llm.mock.calls[1][0] as string).toContain("part 1 of 2");
    const secondPrompt = llm.mock.calls[2][0] as string;
    expect(secondPrompt).toContain("part 2 of 2");
    expect(secondPrompt).toContain("policies/alpha.md");
    // Checkpoint is cleared once the document is fully cataloged.
    expect(state.checkpoint).toBeNull();
  });

  it("resumes from a checkpoint after a mid-document failure, skipping billed chunks", async () => {
    const bigText = `# Alpha\n${"a".repeat(30_000)}\n# Beta\n${"b".repeat(30_000)}`;
    const bigExtract: DistillExtract = async () => ({
      ok: true,
      text: bigText,
      structure: { format: "markdown", sections: sliceMarkdownSections(bigText) },
    });

    // Run 1: outline selects both, part 1 catalogs alpha, part 2 throws.
    const llm1 = vi
      .fn()
      .mockResolvedValueOnce(outlineFence([0, 1]))
      .mockResolvedValueOnce(
        fence([
          { op: "upsert", path: "policies/alpha.md", type: "Policy", title: "Alpha", body: "Alpha one." },
        ]),
      )
      .mockRejectedValueOnce(new Error("provider blew up"));
    const first = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm: llm1, extract: bigExtract });
    expect(first.status).toBe("failed");
    // Checkpoint persisted after part 1 (one chunk done), nothing cataloged.
    expect(state.checkpoint).not.toBeNull();
    expect(state.checkpoint?.cursor).toBe(1);
    expect(state.upserts).toHaveLength(0);

    // Run 2 (the retry): the checkpoint short-circuits the outline pass and
    // part 1, so only part 2 is distilled.
    const llm2 = vi.fn().mockResolvedValueOnce(
      fence([
        { op: "upsert", path: "policies/alpha.md", type: "Policy", title: "Alpha", body: "Alpha two." },
        { op: "upsert", path: "policies/beta.md", type: "Policy", title: "Beta", body: "Beta." },
      ]),
    );
    // The operator retry route forces (to bypass triage); force must still
    // honor the checkpoint rather than re-billing part 1.
    const second = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm: llm2,
      extract: bigExtract,
      force: true,
    });
    expect(second.status).toBe("cataloged");
    expect(llm2).toHaveBeenCalledTimes(1); // no outline, no part-1 re-run
    expect(state.checkpoint).toBeNull(); // cleared on success
    expect(state.upserts).toHaveLength(2);
    const alpha = state.upserts.find((u) => u.path === "policies/alpha.md");
    expect(alpha?.body).toContain("Alpha one.");
    expect(alpha?.body).toContain("Alpha two.");
  });
});

describe("mergeUpsertOps", () => {
  const base = (over: Partial<LibraryUpsertOp>): LibraryUpsertOp => ({
    kind: "upsert",
    path: "policies/p.md",
    type: "Policy",
    title: "P",
    body: "body",
    ...over,
  });

  it("unions tags, concatenates bodies, and keeps the earlier expiry", () => {
    const merged = mergeUpsertOps(
      base({ title: "First", body: "one", tags: ["x"], stale_after: "2027-01-01" }),
      base({ title: "Second", body: "two", tags: ["y"], stale_after: "2026-06-01" }),
    );
    expect(merged.body).toBe("one\n\ntwo");
    expect(merged.tags).toEqual(["x", "y"]);
    expect(merged.title).toBe("First");
    expect(merged.stale_after).toBe("2026-06-01");
  });

  it("does not duplicate an identical body", () => {
    expect(mergeUpsertOps(base({ body: "same" }), base({ body: "same" })).body).toBe("same");
  });
});
