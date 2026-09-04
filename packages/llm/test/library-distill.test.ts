import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryConcept, LibraryDocument } from "../src/work/library";

const state: {
  document: LibraryDocument | null;
  statuses: Array<{ status: string; skipReason?: string | null; error?: string | null }>;
  upserts: Array<Record<string, unknown>>;
  catalog: LibraryConcept[];
  checkpoint: Record<string, unknown> | null;
  removedDerived: number;
} = {
  document: null,
  statuses: [],
  upserts: [],
  catalog: [],
  checkpoint: null,
  removedDerived: 0,
};

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
    async (_org: string, _id: string, checkpoint: Record<string, unknown>) => {
      state.checkpoint = checkpoint;
    },
  ),
  clearLibraryDistillCheckpoint: vi.fn(async () => {
    state.checkpoint = null;
  }),
  clearLibraryTransientState: vi.fn(async () => {
    state.checkpoint = null;
  }),
}));

vi.mock("../src/work/workspace", () => ({
  getOrgAgentRoot: vi.fn(() => workspaceRoot),
}));

vi.mock("../src/library/extract", async (original) => {
  const actual = await original<typeof import("../src/library/extract")>();
  return {
    ...actual,
    removeLibraryDerivedMarkdown: vi.fn(async () => {
      state.removedDerived++;
    }),
  };
});

import {
  mergeUpsertOps,
  runLibraryDistill,
  type DistillExtract,
} from "../src/library/distill";
import { sliceMarkdownSections } from "../src/library/extract";
import type { LibraryUpsertOp } from "../src/library/fence";

const ORG = "org-1";
const POLICY_TEXT = [
  "# Refund policy",
  "",
  "Customers may request refunds within 30 days of purchase.",
  "Refunds above five hundred dollars require CFO approval.",
].join("\n");

const readExtract: DistillExtract = async ({ absolutePath }) => ({
  ok: true,
  text: await readFile(absolutePath, "utf8"),
  structure: { format: "markdown", sections: [] },
});

function document(overrides: Partial<LibraryDocument> = {}): LibraryDocument {
  return {
    id: "doc-1",
    orgId: ORG,
    userId: "user-1",
    sourceThreadId: "thread-1",
    filename: "refund-policy.md",
    relativePath: "uploads/thread-1/refund-policy.md",
    contentHash: "source-hash",
    sizeBytes: 512,
    status: "uploaded",
    skipReason: null,
    error: null,
    extractCheckpoint: null,
    extractedRelativePath: null,
    extractedContentHash: null,
    extractorFingerprint: null,
    extractedAt: null,
    distilledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const fence = (ops: unknown[]): string =>
  ["```neko_library", JSON.stringify(ops), "```"].join("\n");

const upsert = (
  path: string,
  body: string,
  overrides: Record<string, unknown> = {},
) => ({
  op: "upsert",
  path,
  type: "Policy",
  title: path,
  body,
  ...overrides,
});

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "neko-library-distill-"));
  state.document = document();
  state.statuses = [];
  state.upserts = [];
  state.catalog = [];
  state.checkpoint = null;
  state.removedDerived = 0;
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
  it("catalogs every accepted document onto the uploader's personal layer", async () => {
    const llm = vi.fn(async () =>
      fence([
        upsert("policies/refund-policy.md", "Refunds within 30 days.", {
          title: "Refund policy",
        }),
      ]),
    );
    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm,
      extract: readExtract,
    });

    expect(result.status).toBe("cataloged");
    expect(state.statuses.map((item) => item.status)).toEqual([
      "distilling",
      "cataloged",
    ]);
    expect(state.upserts[0]).toMatchObject({
      orgId: ORG,
      userId: "user-1",
      path: "policies/refund-policy.md",
      sourceDocumentId: "doc-1",
    });
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("Customers may request refunds");
    expect(prompt).not.toContain('"op": "skip"');
    expect(state.removedDerived).toBe(1);
  });

  it("passes the existing catalog so concepts are revised instead of duplicated", async () => {
    state.catalog = [
      {
        path: "policies/refund-policy.md",
        title: "Refund policy",
        description: "Old summary",
      } as LibraryConcept,
    ];
    const llm = vi.fn(async () =>
      fence([upsert("policies/refund-policy.md", "Updated body")]),
    );
    await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm,
      extract: readExtract,
    });
    expect(llm.mock.calls[0][0] as string).toContain(
      "policies/refund-policy.md — Refund policy: Old summary",
    );
  });

  it("rejects empty, malformed, or skip-only model output", async () => {
    for (const response of [
      "I could not process this.",
      "```neko_library\nnot json\n```",
      fence([{ op: "skip", reason: "raw data" }]),
    ]) {
      await expect(
        runLibraryDistill({
          orgId: ORG,
          documentId: "doc-1",
          llm: vi.fn(async () => response),
          extract: readExtract,
        }),
      ).rejects.toThrow(/no parseable.*upserts/);
    }
    expect(state.upserts).toHaveLength(0);
    expect(state.statuses.every((item) => item.status !== "cataloged")).toBe(true);
  });

  it("refuses upload paths that escape the org workspace", async () => {
    state.document = document({ relativePath: "../../etc/passwd" });
    await expect(
      runLibraryDistill({
        orgId: ORG,
        documentId: "doc-1",
        llm: vi.fn(),
      }),
    ).rejects.toThrow(/escapes/);
  });

  it("is idempotent for already-cataloged documents", async () => {
    state.document = document({ status: "cataloged" });
    const llm = vi.fn();
    const result = await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm,
      extract: readExtract,
    });
    expect(result.status).toBe("cataloged");
    expect(llm).not.toHaveBeenCalled();
  });

  it("distills every chunk without an outline pass and merges concepts by path", async () => {
    const bigText = `# Alpha\n${"a".repeat(30_000)}\n# Beta\n${"b".repeat(30_000)}`;
    const extract: DistillExtract = async () => ({
      ok: true,
      text: bigText,
      structure: { format: "markdown", sections: sliceMarkdownSections(bigText) },
    });
    const llm = vi
      .fn()
      .mockResolvedValueOnce(
        fence([upsert("policies/alpha.md", "Alpha one.", { tags: ["x"] })]),
      )
      .mockResolvedValueOnce(
        fence([
          upsert("policies/alpha.md", "Alpha two.", { tags: ["y"] }),
          upsert("policies/beta.md", "Beta."),
        ]),
      );

    await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm,
      extract,
    });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(llm.mock.calls[0][0] as string).toContain("part 1 of 2");
    expect(llm.mock.calls[1][0] as string).toContain("part 2 of 2");
    expect(llm.mock.calls[1][0] as string).toContain("policies/alpha.md");
    expect(state.upserts).toHaveLength(2);
    const alpha = state.upserts.find((item) => item.path === "policies/alpha.md");
    expect(alpha?.body).toContain("Alpha one.");
    expect(alpha?.body).toContain("Alpha two.");
    expect(alpha?.tags).toEqual(["x", "y"]);
    expect(state.checkpoint).toBeNull();
  });

  it("retries the malformed chunk from a hash-bound checkpoint", async () => {
    const bigText = `# Alpha\n${"a".repeat(30_000)}\n# Beta\n${"b".repeat(30_000)}`;
    const extract: DistillExtract = async () => ({
      ok: true,
      text: bigText,
      structure: { format: "markdown", sections: sliceMarkdownSections(bigText) },
    });
    const firstLlm = vi
      .fn()
      .mockResolvedValueOnce(fence([upsert("policies/alpha.md", "Alpha one.")]))
      .mockResolvedValueOnce("malformed");
    await expect(
      runLibraryDistill({
        orgId: ORG,
        documentId: "doc-1",
        llm: firstLlm,
        extract,
      }),
    ).rejects.toThrow(/chunk 2/);
    expect(state.checkpoint).toMatchObject({ v: 2, cursor: 1, chunkTotal: 2 });
    expect(state.upserts).toHaveLength(0);

    const retryLlm = vi.fn(async () =>
      fence([
        upsert("policies/alpha.md", "Alpha two."),
        upsert("policies/beta.md", "Beta."),
      ]),
    );
    await runLibraryDistill({
      orgId: ORG,
      documentId: "doc-1",
      llm: retryLlm,
      extract,
      force: true,
    });
    expect(retryLlm).toHaveBeenCalledOnce();
    expect(retryLlm.mock.calls[0][0] as string).toContain("part 2 of 2");
    const alpha = state.upserts.find((item) => item.path === "policies/alpha.md");
    expect(alpha?.body).toContain("Alpha one.");
    expect(alpha?.body).toContain("Alpha two.");
  });
});

describe("mergeUpsertOps", () => {
  const base = (overrides: Partial<LibraryUpsertOp>): LibraryUpsertOp => ({
    kind: "upsert",
    path: "policies/p.md",
    type: "Policy",
    title: "P",
    body: "body",
    ...overrides,
  });

  it("unions tags, concatenates bodies, and keeps the earlier expiry", () => {
    const merged = mergeUpsertOps(
      base({ body: "one", tags: ["x"], stale_after: "2027-01-01" }),
      base({ body: "two", tags: ["y"], stale_after: "2026-06-01" }),
    );
    expect(merged.body).toBe("one\n\ntwo");
    expect(merged.tags).toEqual(["x", "y"]);
    expect(merged.stale_after).toBe("2026-06-01");
  });
});
