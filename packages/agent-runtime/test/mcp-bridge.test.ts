import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_SERVER_NAMES,
  buildBridgeServer,
  buildMultiplexedBridgeServer,
  multiplexedToolName,
} from "../src/mcp-bridge.js";
import { BrokerControlPlane } from "../src/broker-client.js";

function ctx() {
  return {
    orgId: "org-1",
    threadId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    skillsRoot: "/tmp/skills",
    workflowRunId: "33333333-3333-4333-8333-333333333333",
    triggeredByObservationId: null,
    pluginActions: [
      {
        kind: "send_slack_message",
        description: "send",
        scope: "external" as const,
      },
    ],
    controlPlane: new BrokerControlPlane("http://127.0.0.1:9", "tok"),
  };
}

describe("mcp-bridge buildBridgeServer", () => {
  it("constructs a connectable server for every name hermes mounts", () => {
    for (const name of BRIDGE_SERVER_NAMES) {
      const server = buildBridgeServer(name, ctx());
      expect(server.instance, name).toBeTruthy();
      expect(typeof server.instance.connect, name).toBe("function");
    }
  });

  it("throws on unknown server names", () => {
    expect(() => buildBridgeServer("neko_nope", ctx())).toThrow(/unknown server/);
  });

  it("multiplexes logical servers while preserving Hermes-facing tool names", async () => {
    const skillsRoot = await mkdtemp(join(tmpdir(), "neko-mcp-skills-"));
    const multiplexed = await buildMultiplexedBridgeServer(
      ["neko_skills", "neko_memory"],
      { ...ctx(), skillsRoot },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await multiplexed.instance.connect(serverTransport);
    const client = new Client({ name: "multiplexer-test", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain("skills_create_skill");
      expect(names).toContain("memory_search");
      expect(names).toContain("memory_save");
      expect(new Set(names).size).toBe(names.length);
      expect(`mcp_neko_${multiplexedToolName("neko_memory", "search")}`).toBe(
        "mcp_neko_memory_search",
      );

      const result = await client.callTool({
        name: "skills_create_skill",
        arguments: {
          name: "benchmark-helper",
          description: "A deterministic bridge routing test.",
          body: "Return the benchmark marker.",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("benchmark-helper");
    } finally {
      await client.close();
      await multiplexed.instance.close();
      await rm(skillsRoot, { recursive: true, force: true });
    }
  });
});
