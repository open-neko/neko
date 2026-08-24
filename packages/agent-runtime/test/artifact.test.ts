import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRuntimeManifest } from "../src/runtime-contract";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distRoot = join(packageRoot, "dist");

describe("built agent runtime artifact", () => {
  it("declares all executable and filesystem roles", async () => {
    const manifest = JSON.parse(
      await readFile(join(distRoot, "agent-runtime-manifest.json"), "utf8"),
    ) as AgentRuntimeManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.roles).toEqual({
      agentEntry: "agent-entry.js",
      mcpBridge: "mcp-bridge.js",
      builtinSkills: "assets/builtin-skills",
      graphjinCompactCli: "tool-output/compact-cli.mjs",
    });
    expect(manifest.files.map((file) => file.path)).toContain(
      "tool-output/compact-cli.mjs",
    );
    expect(
      manifest.files.filter((file) =>
        file.path.startsWith("assets/builtin-skills/"),
      ).length,
    ).toBeGreaterThan(200);
  });

  it("passes the complete preflight with a clean supervised environment", () => {
    const result = spawnSync(
      process.execPath,
      [join(distRoot, "agent-entry.js"), "--preflight"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
        timeout: 60_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const preflight = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(preflight).toMatchObject({
      status: "ok",
      lazyInstallsDisabled: true,
      skillsReady: true,
      graphjinGuardReady: true,
      bridgeReady: true,
      bridgeServers: 17,
    });
  });
});
