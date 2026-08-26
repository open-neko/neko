import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildRenderCardsServer } from "../src/work/tools";

async function withRenderServer(
  run: (client: Client, emit: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  const emit = vi.fn(async () => {});
  const server = buildRenderCardsServer(emit);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "render-server-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await run(client, emit);
  } finally {
    await client.close();
  }
}

describe("brokered neko_ui render MCP server", () => {
  it("rejects a render call that does not match the canonical schema", async () => {
    await withRenderServer(async (client, emit) => {
      const result = await client.callTool({
        name: "render_cards",
        arguments: { messages: [{ version: "v1.0" }] },
      });
      expect(result.isError).toBe(true);
      expect(emit).not.toHaveBeenCalled();
    });
  });

  it("emits a valid A2UI v1.0 surface from the one canonical server", async () => {
    const messages = [
      {
        version: "v1.0",
        createSurface: {
          surfaceId: "weather",
          catalogId: "urn:openneko:catalog:work:v2",
          components: [{ id: "root", component: "Answer" }],
        },
      },
    ];
    await withRenderServer(async (client, emit) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["render_cards"]);

      const result = await client.callTool({
        name: "render_cards",
        arguments: { messages },
      });
      expect(result).toMatchObject({
        content: [
          {
            type: "text",
            text: '{"ok":true,"accepted":1}',
          },
        ],
      });
      expect(emit).toHaveBeenCalledWith({ type: "surface", messages });
    });
  });
});
