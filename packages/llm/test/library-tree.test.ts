import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, rebuildIndexes, writeConceptDoc } from "../src/library/tree";
import { parseConceptDoc } from "../src/library/okf";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "neko-library-tree-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const doc = (title: string, description?: string) => ({
  type: "Policy",
  title,
  description,
  status: "draft" as const,
  body: `# ${title}\n\nDetails.`,
});

describe("library tree", () => {
  it("writes concept docs at nested bundle-relative paths", async () => {
    await writeConceptDoc(root, {
      path: "policies/refund-policy.md",
      doc: doc("Refund policy"),
    });
    const raw = await readFile(join(root, "policies", "refund-policy.md"), "utf8");
    const parsed = parseConceptDoc(raw);
    expect(parsed?.title).toBe("Refund policy");
    expect(parsed?.status).toBe("draft");
  });

  it("rejects invalid concept paths", async () => {
    await expect(
      writeConceptDoc(root, { path: "../escape.md", doc: doc("x") }),
    ).rejects.toThrow(/invalid concept path/);
  });

  it("rebuilds index.md per directory with okf_version at root", async () => {
    await writeConceptDoc(root, {
      path: "policies/refund-policy.md",
      doc: doc("Refund policy", "Approval rules."),
    });
    await writeConceptDoc(root, {
      path: "contracts/acme-msa.md",
      doc: doc("Acme MSA"),
    });
    await rebuildIndexes(root);

    const rootIndex = await readFile(join(root, "index.md"), "utf8");
    expect(rootIndex).toContain('okf_version: "0.2"');
    expect(rootIndex).toContain("[contracts/](contracts/index.md)");
    expect(rootIndex).toContain("[policies/](policies/index.md)");

    const policiesIndex = await readFile(join(root, "policies", "index.md"), "utf8");
    expect(policiesIndex).toContain(
      "[Refund policy](refund-policy.md) — Approval rules.",
    );
    expect(policiesIndex).not.toContain("okf_version");
  });

  it("excludes reserved files from indexes", async () => {
    await writeConceptDoc(root, { path: "a.md", doc: doc("A") });
    await appendLog(root, "seeded", new Date("2026-08-18T00:00:00Z"));
    await rebuildIndexes(root);
    const rootIndex = await readFile(join(root, "index.md"), "utf8");
    expect(rootIndex).not.toContain("log.md");
    expect(rootIndex).not.toContain("[index");
  });

  it("appends log lines chronologically", async () => {
    await appendLog(root, "first", new Date("2026-08-18T00:00:00Z"));
    await appendLog(root, "second\nwith newline", new Date("2026-08-18T01:00:00Z"));
    const log = await readFile(join(root, "log.md"), "utf8");
    expect(log.startsWith("# Log\n")).toBe(true);
    const lines = log.trim().split("\n").slice(-2);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("second with newline");
  });

  it("rebuildIndexes is a no-op when the bundle root is missing", async () => {
    await expect(rebuildIndexes(join(root, "missing"))).resolves.toBeUndefined();
  });
});
