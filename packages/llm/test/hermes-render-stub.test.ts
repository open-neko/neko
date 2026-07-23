import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ensureRenderStub } from "../src/agent-backends/hermes";

async function callRender(argumentsValue: unknown): Promise<Record<string, unknown>> {
  const child = spawn(process.execPath, [ensureRenderStub()], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    child.on("error", reject);
  });
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "render_cards", arguments: argumentsValue },
    })}\n`,
  );
  try {
    return await response;
  } finally {
    child.kill();
  }
}

describe("Hermes render MCP stub", () => {
  it("rejects a render call when no valid A2UI messages are present", async () => {
    const response = await callRender({ messages: [{ version: "v1.0" }] });
    expect(response).toMatchObject({
      result: {
        isError: true,
      },
    });
  });

  it("accepts a valid A2UI v1.0 surface", async () => {
    const response = await callRender({
      messages: [
        {
          version: "v1.0",
          createSurface: {
            surfaceId: "weather",
            catalogId: "urn:openneko:catalog:work:v2",
            components: [{ id: "root", component: "Answer" }],
          },
        },
      ],
    });
    expect(response).toMatchObject({
      result: {
        content: [
          {
            type: "text",
            text: "{\"ok\":true,\"accepted\":1}",
          },
        ],
      },
    });
    expect((response.result as Record<string, unknown>).isError).toBeUndefined();
  });
});
