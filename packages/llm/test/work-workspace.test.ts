import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copySkillOverrides,
  ensureIsolatedJobWorkspace,
  ensureOrgWorkspace,
  ensureWorkWorkspace,
  materializeBuiltinSkills,
} from "../src/work/workspace";

const cleanupPaths: string[] = [];
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
  delete process.env.HOME;
  delete process.env.OPENNEKO_AGENT_HOME;
  delete process.env.OPENNEKO_HOST_WEB_DEV;
  delete process.env.OPENNEKO_STACK_MODE;
  delete process.env.NEXT_PUBLIC_DEMO;
  delete process.env.DEMO;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("work workspace", () => {
  it("supports an isolated agent home in explicit host-web development mode", async () => {
    const agentHome = await mkdtemp(join(tmpdir(), "neko-agent-home-"));
    cleanupPaths.push(agentHome);
    process.env.OPENNEKO_AGENT_HOME = agentHome;
    process.env.OPENNEKO_HOST_WEB_DEV = "1";
    process.env.NODE_ENV = "development";

    const workspace = await ensureOrgWorkspace("org-test");
    expect(workspace.orgRoot).toBe(
      join(agentHome, ".config", "openneko", "agents", "orgs", "org-test"),
    );
  }, 30_000);

  it.each([
    ["production", { NODE_ENV: "production" }],
    ["demo stack", { NODE_ENV: "development", OPENNEKO_STACK_MODE: "demo" }],
    ["demo UI", { NODE_ENV: "development", NEXT_PUBLIC_DEMO: "true" }],
  ])("ignores the host-web agent home in %s mode", async (_label, mode) => {
    const home = await mkdtemp(join(tmpdir(), "neko-work-home-"));
    const agentHome = await mkdtemp(join(tmpdir(), "neko-agent-home-"));
    cleanupPaths.push(home, agentHome);
    process.env.HOME = home;
    process.env.OPENNEKO_AGENT_HOME = agentHome;
    process.env.OPENNEKO_HOST_WEB_DEV = "1";
    Object.assign(process.env, mode);

    const workspace = await ensureOrgWorkspace("org-test");
    expect(workspace.orgRoot).toBe(
      join(home, ".config", "openneko", "agents", "orgs", "org-test"),
    );
  }, 30_000);

  it("seeds built-in skills into the org workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "neko-work-home-"));
    cleanupPaths.push(home);
    process.env.HOME = home;

    const workspace = await ensureOrgWorkspace("org-test");
    const skills = await readdir(workspace.skillsRoot);
    expect(skills).toContain("app-builder");
    expect(skills).toContain("crm");
    expect(skills).toContain("records");
    expect(skills).toContain("support-desk");
    expect(skills).toContain("skill-creator");
    expect(skills).toContain("pdf");
  }, 30_000);

  it("creates per-thread and per-run directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "neko-work-home-"));
    cleanupPaths.push(home);
    process.env.HOME = home;

    const workspace = await ensureWorkWorkspace("org-test", "thread-1", "run-1");
    expect(workspace.threadUploadsRoot).toContain("thread-1");
    expect(workspace.artifactRoot).toContain("run-1");
  }, 30_000);

  it("stages only custom and modified skill bodies, then fills built-ins from the image", async () => {
    const home = await mkdtemp(join(tmpdir(), "neko-work-home-"));
    const stage = await mkdtemp(join(tmpdir(), "neko-skills-stage-"));
    cleanupPaths.push(home, stage);
    process.env.HOME = home;

    const workspace = await ensureOrgWorkspace("org-test");
    const modified = join(workspace.skillsRoot, "skill-creator", "SKILL.md");
    await writeFile(modified, `${await readFile(modified, "utf8")}\nOrg override.\n`);
    const custom = join(workspace.skillsRoot, "quarterly-review");
    await mkdir(custom, { recursive: true });
    await writeFile(
      join(custom, "SKILL.md"),
      "---\nname: quarterly-review\ndescription: Prepare quarterly reviews\n---\n",
    );

    const stagedSkills = join(stage, "skills");
    const copied = await copySkillOverrides(workspace.skillsRoot, stagedSkills);
    expect(copied).toContain("quarterly-review");
    expect(copied).toContain("skill-creator");
    expect(copied).not.toContain("pdf");

    await materializeBuiltinSkills(stagedSkills);
    expect(await readdir(stagedSkills)).toContain("pdf");
    expect(await readFile(join(stagedSkills, "skill-creator", "SKILL.md"), "utf8"))
      .toContain("Org override.");
  }, 30_000);

  it("creates an empty disposable tree for non-interactive agent jobs", async () => {
    const isolated = await ensureIsolatedJobWorkspace("profile/job-1");
    const rootEntries = await readdir(isolated.workspace.orgRoot);

    expect(isolated.workspace.orgRoot).toContain("openneko-agent-profile_job-1-");
    expect(rootEntries.sort()).toEqual([
      "knowledge",
      "memory",
      "runs",
      "skills",
      "uploads",
    ]);
    expect(await readdir(isolated.workspace.memoryRoot)).toEqual([]);
    expect(await readdir(isolated.workspace.skillsRoot)).toEqual([]);

    await isolated.cleanup();
    await expect(access(isolated.workspace.orgRoot)).rejects.toThrow();
  });
});
