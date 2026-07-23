import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPnpmWorkspaceRoot,
  packageInstallCommand,
} from "../../src/plugins/manage-adapters";

describe("packageInstallCommand", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("uses the workspace package manager inside the OpenNeko monorepo", () => {
    expect(
      packageInstallCommand(
        ["install", "@open-neko/plugin-parallel-search@0.3.1"],
        true,
      ),
    ).toEqual({
      command: "pnpm",
      args: ["add", "@open-neko/plugin-parallel-search@0.3.1"],
    });
  });

  it("keeps npm for packaged deployments", () => {
    expect(
      packageInstallCommand(
        ["install", "@open-neko/plugin-parallel-search@0.3.1"],
        false,
      ),
    ).toEqual({
      command: "npm",
      args: ["install", "@open-neko/plugin-parallel-search@0.3.1"],
    });
  });

  it("finds a pnpm workspace above the worker package directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "openneko-pnpm-"));
    cleanup.push(root);
    const worker = join(root, "apps", "worker");
    await mkdir(worker, { recursive: true });
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");

    expect(await findPnpmWorkspaceRoot(worker)).toBe(root);
  });
});
