import { describe, expect, it } from "vitest";
import { packageInstallCommand } from "../../src/plugins/manage-adapters";

describe("packageInstallCommand", () => {
  it("uses the workspace package manager inside the OpenNeko monorepo", () => {
    expect(
      packageInstallCommand(
        ["install", "@open-neko/plugin-parallel-search@0.3.1"],
        true,
      ),
    ).toEqual({
      command: "pnpm",
      args: [
        "add",
        "--workspace-root",
        "@open-neko/plugin-parallel-search@0.3.1",
      ],
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
});
