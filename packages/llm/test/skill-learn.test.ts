import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSkillLearn } from "../src/work/skill-learn";
import { scanLearnedText } from "../src/work/skill-learn-scan";
import { fingerprintSkillTree } from "../src/work/workspace";

const MAGENTO_REFUNDS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packs/magento/skills/magento-investigate-refunds",
);

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

function usages(count: number, createdAt: Date) {
  return Array.from({ length: count }, (_, index) => ({
    runId: `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`,
    skillName: "magento-investigate-refunds",
    contentHash: "same-hash",
    createdAt,
  }));
}

describe("skill-learn module boundary", () => {
  it("does not write memories or library concepts", () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/work/skill-learn.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/work_memory|library_concept|rememberWorkMemory/);
  });
});

describe("scanLearnedText", () => {
  it("rejects secrets, PII, frontmatter, tools, and boundary edits", () => {
    expect(scanLearnedText("api_key=sk-abc1234567890xyz").some((h) => h.code === "secret")).toBe(
      true,
    );
    expect(scanLearnedText("email ops@example.com").some((h) => h.code === "pii")).toBe(true);
    expect(scanLearnedText("---\nname: hijack\n---").some((h) => h.code === "frontmatter")).toBe(
      true,
    );
    expect(scanLearnedText("allowed-tools: bash").some((h) => h.code === "tools")).toBe(true);
    expect(
      scanLearnedText("Boundary: Never refund").some((h) => h.code === "boundary"),
    ).toBe(true);
    expect(scanLearnedText("Never return an item to its origin.")).toEqual([]);
  });
});

describe("runSkillLearn", () => {
  it("skips below the repeat threshold and still returns a decision trace", async () => {
    const orgRoot = await mkdtemp(join(tmpdir(), "neko-learn-skip-"));
    cleanupPaths.push(orgRoot);
    const result = await runSkillLearn({
      orgId: "org",
      orgRoot,
      skillName: "magento-investigate-refunds",
      orgEnabled: true,
      skillEnabled: true,
      usages: usages(4, new Date(0)),
      settlementMs: 0,
      minRepeats: 5,
    });
    expect(result.decision).toBe("skipped");
    expect(result.reason).toBe("below_repeat_threshold");
    expect(result.trace.skipReason).toMatch(/settled 4 < 5/);
    expect(result.trace.evidenceRunIds).toHaveLength(4);
  });

  it("applies additive LEARNED.md and does not rewrite pack SKILL.md", async () => {
    const orgRoot = await mkdtemp(join(tmpdir(), "neko-learn-apply-"));
    cleanupPaths.push(orgRoot);
    const skillDir = join(orgRoot, "skills", "magento-investigate-refunds");
    await mkdir(skillDir, { recursive: true });
    const original = await readFile(join(MAGENTO_REFUNDS, "SKILL.md"), "utf8");
    await writeFile(join(skillDir, "SKILL.md"), original, "utf8");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(
      join(skillDir, "references", "refunds-and-cancellations.md"),
      await readFile(
        join(MAGENTO_REFUNDS, "references", "refunds-and-cancellations.md"),
        "utf8",
      ),
    );
    const baseHash = await fingerprintSkillTree(skillDir);
    const result = await runSkillLearn({
      orgId: "org",
      orgRoot,
      skillName: "magento-investigate-refunds",
      orgEnabled: true,
      skillEnabled: true,
      usages: usages(5, new Date(0)),
      settlementMs: 0,
      minRepeats: 5,
      currentBaseHash: baseHash,
      propose: async () => ({
        lesson: "keep credit-memo math on parent items",
        rationale: "five settled refunds runs double-counted child rows",
        learnedMarkdown: "Prefer parent items when product structures would double-count.",
        evidenceRunIds: usages(5, new Date(0)).map((usage) => usage.runId),
      }),
    });
    expect(result.decision).toBe("applied");
    expect(result.trace.lesson).toContain("parent items");
    expect(result.trace.rationale).toContain("double-counted");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe(original);
    const learned = await readFile(
      join(orgRoot, "skill-overlays", "magento-investigate-refunds", "LEARNED.md"),
      "utf8",
    );
    expect(learned).toContain("Prefer parent items");
    expect(learned).toContain(`base_hash: ${baseHash}`);
  });

  it("rejects a secret-bearing candidate", async () => {
    const orgRoot = await mkdtemp(join(tmpdir(), "neko-learn-secret-"));
    cleanupPaths.push(orgRoot);
    const skillDir = join(orgRoot, "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Demo\n", "utf8");
    const result = await runSkillLearn({
      orgId: "org",
      orgRoot,
      skillName: "demo",
      orgEnabled: true,
      skillEnabled: true,
      usages: usages(5, new Date(0)).map((usage) => ({
        ...usage,
        skillName: "demo",
      })),
      settlementMs: 0,
      propose: async () => ({
        lesson: "leak",
        rationale: "bad",
        learnedMarkdown: "Store GEMINI api_key=sk-abc1234567890xyz in the skill.",
        evidenceRunIds: ["r1"],
      }),
    });
    expect(result.decision).toBe("rejected");
    expect(result.reason).toMatch(/secret/i);
  });

  it("refuses a frontmatter rewrite", async () => {
    const orgRoot = await mkdtemp(join(tmpdir(), "neko-learn-fm-"));
    cleanupPaths.push(orgRoot);
    const skillDir = join(orgRoot, "skills", "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Demo\n", "utf8");
    const result = await runSkillLearn({
      orgId: "org",
      orgRoot,
      skillName: "demo",
      orgEnabled: true,
      skillEnabled: true,
      usages: usages(5, new Date(0)).map((usage) => ({
        ...usage,
        skillName: "demo",
      })),
      settlementMs: 0,
      propose: async () => ({
        lesson: "hijack",
        rationale: "bad",
        learnedMarkdown: "---\nname: evil\n---\n",
        evidenceRunIds: ["r1"],
      }),
    });
    expect(result.decision).toBe("rejected");
    expect(result.reason).toMatch(/frontmatter/i);
  });
});
