import { describe, expect, it } from "vitest";
import {
  configureAgentRuntime,
  resolveMcpBridgePath,
} from "../../src/agent-sandbox/runtime-contract";

describe("agent sandbox runtime contract", () => {
  it("self-locates the MCP bridge beside the standalone agent bundle", () => {
    expect(
      resolveMcpBridgePath(
        "file:///app/agent-entry.js",
        (candidate) => candidate === "/app/mcp-bridge.js",
      ),
    ).toBe("/app/mcp-bridge.js");
  });

  it("applies only the non-secret runtime defaults the agent owns", () => {
    const env: NodeJS.ProcessEnv = {};
    const runtime = configureAgentRuntime({
      entryUrl: "file:///app/agent-entry.js",
      env,
      pathExists: (candidate) => candidate === "/app/mcp-bridge.js",
    });

    expect(runtime).toEqual({ mcpBridgePath: "/app/mcp-bridge.js" });
    expect(env).toEqual({
      HERMES_DISABLE_LAZY_INSTALLS: "1",
      OPENNEKO_MCP_BRIDGE: "/app/mcp-bridge.js",
    });
  });

  it("fails preflight with the incompatible image path", () => {
    expect(() =>
      configureAgentRuntime({
        entryUrl: "file:///broken/agent-entry.js",
        env: {},
        pathExists: () => false,
      }),
    ).toThrow(
      "agent runtime contract invalid: MCP bridge not found at /broken/mcp-bridge.js",
    );
  });
});
