import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildBridgeServer,
  buildMultiplexedBridgeServer,
  multiplexedToolName,
} from "../../src/agent-sandbox/mcp-bridge.js";
import { BrokerControlPlane } from "../../src/agent-sandbox/broker-client.js";

const SERVERS = [
  "neko_graphjin",
  "neko_graphjin_agent",
  "neko_skills",
  "neko_memory",
  "neko_records",
  "neko_workflow_builder",
  "neko_workflow_output",
  "neko_action",
  "neko_rule_builder",
  "neko_plugin_manager",
  "neko_user_manager",
  "neko_channel_manager",
  "neko_data_source_manager",
  "neko_source_config_manager",
  "neko_audit",
  "neko_plugin_actions",
];

function ctx() {
  return {
    runKind: "work" as const,
    orgId: "org-1",
    threadId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    skillsRoot: "/tmp/skills",
    workflowRunId: "33333333-3333-4333-8333-333333333333",
    triggeredByObservationId: null,
    pluginActions: [
      {
        kind: "send_slack_message",
        pluginId: "@open-neko/plugin-slack",
        description: "send",
        scope: "external" as const,
      },
    ],
    controlPlane: new BrokerControlPlane("http://127.0.0.1:9", "tok"),
  };
}

async function callGraphjinTool(runKind: "work" | "agent-job") {
  const queryGraphjinRead = vi.fn(async () => ({ data: { ok: true } }));
  const logical = buildBridgeServer("neko_graphjin", {
    ...ctx(),
    runKind,
    controlPlane: { queryGraphjinRead } as unknown as BrokerControlPlane,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await logical.instance.connect(serverTransport);
  const client = new Client({ name: "graphjin-identity-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: "execute_graphql",
      arguments: { query: "query { sales_order { entity_id } }" },
    });
  } finally {
    await client.close();
  }
  return queryGraphjinRead;
}

describe("mcp-bridge buildBridgeServer", () => {
  it("constructs a connectable server for every name hermes mounts", () => {
    for (const name of SERVERS) {
      const server = buildBridgeServer(name, ctx());
      expect(server.instance, name).toBeTruthy();
      expect(typeof server.instance.connect, name).toBe("function");
    }
  });

  it("throws on unknown server names", () => {
    expect(() => buildBridgeServer("neko_nope", ctx())).toThrow(/unknown server/);
  });

  it("binds work GraphJin reads to the actor run", async () => {
    const query = await callGraphjinTool("work");
    expect(query).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "22222222-2222-4222-8222-222222222222",
      query: "query { sales_order { entity_id } }",
    });
  });

  it("omits a run binding for service-identity agent jobs", async () => {
    const query = await callGraphjinTool("agent-job");
    expect(query).toHaveBeenCalledWith({
      orgId: "org-1",
      query: "query { sales_order { entity_id } }",
    });
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
