import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUNTIME_MANIFEST,
  configureAgentRuntime,
  verifyAgentRuntime,
  type AgentRuntimeManifest,
} from "../src/runtime-contract";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function manifest(
  files: AgentRuntimeManifest["files"] = [],
): AgentRuntimeManifest {
  return {
    schemaVersion: 1,
    packageVersion: "test",
    roles: {
      agentEntry: "agent-entry.js",
      mcpBridge: "mcp-bridge.js",
      builtinSkills: "assets/builtin-skills",
      graphjinCompactCli: "tool-output/compact-cli.mjs",
    },
    runtimeDefaults: { HERMES_DISABLE_LAZY_INSTALLS: "1" },
    files,
  };
}

describe("agent runtime contract", () => {
  it("derives every runtime path from one manifest and owns clean-env defaults", () => {
    const env: NodeJS.ProcessEnv = {};
    const expected = new Set([
      "/app/agent-entry.js",
      "/app/mcp-bridge.js",
      "/app/assets/builtin-skills",
      "/app/tool-output/compact-cli.mjs",
    ]);
    const runtime = configureAgentRuntime({
      entryUrl: "file:///app/agent-entry.js",
      env,
      pathExists: (candidate) => expected.has(candidate),
      readText: () => JSON.stringify(manifest()),
    });

    expect(runtime.mcpBridgePath).toBe("/app/mcp-bridge.js");
    expect(runtime.builtinSkillsRoot).toBe("/app/assets/builtin-skills");
    expect(runtime.graphjinCompactCliPath).toBe(
      "/app/tool-output/compact-cli.mjs",
    );
    expect(env).toEqual({
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      OPENNEKO_MCP_BRIDGE: "/app/mcp-bridge.js",
      OPENNEKO_BUILTIN_SKILLS_ROOT: "/app/assets/builtin-skills",
      OPENNEKO_GRAPHJIN_COMPACT_CLI: "/app/tool-output/compact-cli.mjs",
    });
  });

  it("rejects missing declared roles before the agent starts", () => {
    expect(() =>
      configureAgentRuntime({
        entryUrl: "file:///broken/agent-entry.js",
        env: {},
        pathExists: (candidate) => !candidate.endsWith("compact-cli.mjs"),
        readText: () => JSON.stringify(manifest()),
      }),
    ).toThrow(/graphjinCompactCli not found/);
  });

  it("detects a tampered artifact by checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-runtime-contract-"));
    tempRoots.push(root);
    const contents = "original";
    const files = [
      {
        path: "agent-entry.js",
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
    ];
    await writeFile(join(root, "agent-entry.js"), contents);
    await writeFile(
      join(root, AGENT_RUNTIME_MANIFEST),
      JSON.stringify(manifest(files)),
    );
    const contract = {
      root,
      manifestPath: join(root, AGENT_RUNTIME_MANIFEST),
      manifest: manifest(files),
      agentEntryPath: join(root, "agent-entry.js"),
      mcpBridgePath: join(root, "mcp-bridge.js"),
      builtinSkillsRoot: join(root, "assets/builtin-skills"),
      graphjinCompactCliPath: join(root, "tool-output/compact-cli.mjs"),
    };

    await expect(verifyAgentRuntime(contract)).resolves.toBeUndefined();
    await writeFile(join(root, "undeclared.txt"), "not in the manifest");
    await expect(verifyAgentRuntime(contract)).rejects.toThrow(
      /undeclared=undeclared.txt/,
    );
    await rm(join(root, "undeclared.txt"));
    await writeFile(join(root, "agent-entry.js"), "tampered");
    await expect(verifyAgentRuntime(contract)).rejects.toThrow(
      /checksum mismatch for agent-entry.js/,
    );
  });
});
