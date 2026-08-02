import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControlPlane } from "../src/work/control-plane";

const sdk = vi.hoisted(() => ({
  tools: new Map<
    string,
    {
      description: string;
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }
  >(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((input: unknown) => input),
  tool: vi.fn(
    (
      name: string,
      description: string,
      _schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>,
    ) => {
      sdk.tools.set(name, { description, handler });
      return { name };
    },
  ),
}));

import { buildRecordsReadServer } from "../src/work/tools";

describe("native records read tools", () => {
  beforeEach(() => sdk.tools.clear());

  it("binds catalog and generated queries to the trusted org/run context", async () => {
    const listRecordCatalog = vi.fn(async () => ({ apps: [] }));
    const findRecords = vi.fn(async () => ({ rows: [], total: 0, cursor: null }));
    const getRecord = vi.fn(async () => ({ row: null }));
    buildRecordsReadServer({
      orgId: "org-1",
      runId: "run-1",
      controlPlane: {
        listRecordCatalog,
        findRecords,
        getRecord,
      } as unknown as AgentControlPlane,
    });

    await sdk.tools.get("browse_catalog")?.handler({ app: "equipment" });
    await sdk.tools.get("find_records")?.handler({
      app: "equipment",
      object: "loan",
      search: "Camera",
      first: 5,
    });
    await sdk.tools.get("get_record")?.handler({
      app: "equipment",
      object: "loan",
      id: "loan-1",
    });

    expect(listRecordCatalog).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      appId: "equipment",
    });
    expect(findRecords).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        runId: "run-1",
        appId: "equipment",
        objectApiName: "loan",
        search: "Camera",
      }),
    );
    expect(getRecord).toHaveBeenCalledWith({
      orgId: "org-1",
      runId: "run-1",
      appId: "equipment",
      objectApiName: "loan",
      recordId: "loan-1",
    });
  });

  it("makes ID resolution and disambiguation part of the mutation contract", () => {
    buildRecordsReadServer({
      orgId: "org-1",
      runId: "run-1",
      controlPlane: {} as AgentControlPlane,
    });
    const find = sdk.tools.get("find_records");
    expect(find?.description).toContain("exact id");
    expect(find?.description).toContain("disambiguate");
    expect(find?.description).toContain("never guess");
  });
});
