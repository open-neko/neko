import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

type ToolShape = z.ZodRawShape;

export type NekoMcpToolDefinition<Schema extends ToolShape = ToolShape> = {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (
    args: z.infer<z.ZodObject<Schema>>,
    extra: unknown,
  ) => Promise<CallToolResult>;
};

export type NekoMcpServer = {
  type: "sdk";
  name: string;
  instance: McpServer;
};

/**
 * Define an OpenNeko MCP tool without coupling its schema or handler to an
 * agent vendor SDK. The same definition is mounted by Hermes through the
 * sandbox's stdio MCP bridge.
 */
export function defineMcpTool<Schema extends ToolShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: NekoMcpToolDefinition<Schema>["handler"],
): NekoMcpToolDefinition<Schema> {
  return { name, description, inputSchema, handler };
}

/** Build a standard MCP server around OpenNeko's logical tool definitions. */
export function createMcpServer(opts: {
  name: string;
  version?: string;
  tools?: Array<NekoMcpToolDefinition<any>>;
}): NekoMcpServer {
  const instance = new McpServer({
    name: opts.name,
    version: opts.version ?? "1.0.0",
  });
  for (const definition of opts.tools ?? []) {
    instance.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      (args: Record<string, unknown>, extra: unknown) =>
        definition.handler(args, extra),
    );
  }
  return { type: "sdk", name: opts.name, instance };
}
