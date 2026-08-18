import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
} = { document: null, statuses: [], upserts: [], catalog: [] };

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
}));

vi.mock("../src/work/workspace", () => ({
  getOrgAgentRoot: vi.fn(() => workspaceRoot),
}));

import { runLibraryDistill } from "../src/library/distill";

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

const FENCE_REPLY = [
  "Cataloged.",
  "```neko_library",
  JSON.stringify([
    {
      upsert: {
        path: "policies/refund-policy.md",
        type: "Policy",
        title: "Refund policy",
        description: "Refund windows and approval limits.",
        tags: ["finance"],
        body: "Refunds within 30 days; >$500 needs CFO approval.",
      },
    },
  ]),
  "```",
].join("\n");

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "neko-library-distill-"));
  state.document = document();
  state.statuses = [];
  state.upserts = [];
  state.catalog = [];
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
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm });

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
    await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm });
    const prompt = llm.mock.calls[0][0] as string;
    expect(prompt).toContain("- policies/refund-policy.md — Refund policy: Old summary");
  });

  it("skips when the librarian emits a skip op", async () => {
    const llm = vi.fn(async () =>
      "```neko_library\n" +
        JSON.stringify([{ skip: { reason: "one-off working data" } }]) +
        "\n```",
    );
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm });
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
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm });
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
    const result = await runLibraryDistill({ orgId: ORG, documentId: "doc-1", llm });
    expect(result.status).toBe("cataloged");
    expect(state.statuses).toHaveLength(0);
    expect(llm).not.toHaveBeenCalled();
  });
});

