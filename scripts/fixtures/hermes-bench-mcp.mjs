#!/usr/bin/env node

import { createInterface } from "node:readline";

const serverIds = process.argv.slice(2);
if (serverIds.length === 0) serverIds.push("0");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof frame?.id !== "number" || typeof frame?.method !== "string") return;

  switch (frame.method) {
    case "initialize":
      respond(frame.id, {
        protocolVersion: frame.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `openneko-bench-${serverIds.join("-")}`, version: "1.0.0" },
      });
      break;
    case "ping":
      respond(frame.id, {});
      break;
    case "tools/list":
      respond(frame.id, {
        tools: serverIds.map((serverId) => ({
            name: `bench_tool_${serverId}`,
            description: "Return a deterministic benchmark response.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              additionalProperties: false,
            },
          })),
      });
      break;
    case "tools/call": {
      const serverId = String(frame.params?.name || "").replace(/^bench_tool_/, "");
      respond(frame.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify({ serverId, value: frame.params?.arguments?.value || "ok" }),
          },
        ],
        isError: false,
      });
      break;
    }
    default:
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: `unsupported method: ${frame.method}` },
        })}\n`,
      );
  }
});
