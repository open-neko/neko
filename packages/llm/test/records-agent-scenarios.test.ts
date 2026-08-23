import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@neko/llm";
import type { AgentControlPlane } from "@neko/llm/work";

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

vi.mock("../src/mcp-server", () => ({
  createMcpServer: vi.fn((input: unknown) => input),
  defineMcpTool: vi.fn(
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

import {
  buildPluginActionServer,
  buildRecordsReadServer,
  type PluginActionDescriptor,
} from "../src/work/tools.js";
import { listRecordAppBlueprints, loadRecordAppBlueprint } from "@neko/records";

type TranscriptEntry =
  | { role: "user" | "assistant"; text: string }
  | {
      role: "tool";
      name: string;
      input: Record<string, unknown>;
      result: Record<string, unknown>;
    };

async function callTool(
  transcript: TranscriptEntry[],
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const registered = sdk.tools.get(name);
  if (!registered) throw new Error(`scenario tool ${name} is not registered`);
  const response = await registered.handler(input);
  const text = response.content[0]?.text;
  if (typeof text !== "string") throw new Error(`${name} returned no text result`);
  const result = JSON.parse(text) as Record<string, unknown>;
  transcript.push({ role: "tool", name, input, result });
  return result;
}

function actionDescriptor(kind: "app_create" | "record_update"): PluginActionDescriptor {
  return {
    kind,
    scope: "internal",
    description:
      kind === "app_create"
        ? "Create a complete governed records app from one reviewed schema payload."
        : "Update one exact record id with optimistic expected values.",
    default_mode: "ask",
  };
}

async function blueprintCatalog(input: { blueprintId?: string }) {
  const blueprints = input.blueprintId
    ? [await loadRecordAppBlueprint(input.blueprintId)]
    : await listRecordAppBlueprints();
  return {
    blueprints: blueprints.map((blueprint) => ({
      id: blueprint.id,
      version: blueprint.version,
      description: blueprint.description,
      ...(input.blueprintId ? { payload: blueprint.payload } : {}),
    })),
  };
}

describe("records agent scenario transcripts", () => {
  beforeEach(() => sdk.tools.clear());

  it("loads and proposes one complete app_create card from a blueprint", async () => {
    const transcript: TranscriptEntry[] = [
      {
        role: "user",
        text: "Create a CRM for accounts, contacts, deals, and follow-up.",
      },
    ];
    const events: AgentEvent[] = [];
    const createActionRequest = vi.fn(async (input: Record<string, unknown>) => ({
      id: "request-crm",
      ...input,
    }));
    const controlPlane = {
      listRecordBlueprints: vi.fn(async (input: { blueprintId?: string }) =>
        blueprintCatalog(input),
      ),
      evaluateActionPolicy: vi.fn(async () => ({
        decision: "needs_approval",
        reason: "admin approval required",
        policy: { id: "policy-app-create", name: "Review app creation" },
      })),
      createActionRequest,
    } as unknown as AgentControlPlane;

    buildRecordsReadServer({ orgId: "org-a", runId: "run-a", controlPlane });
    buildPluginActionServer({
      orgId: "org-a",
      threadId: "thread-a",
      runId: "run-a",
      descriptors: [actionDescriptor("app_create")],
      emit: async (event) => events.push(event),
      controlPlane,
    });

    const listed = await callTool(transcript, "browse_blueprints", {});
    expect(listed.blueprints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "crm" }),
        expect.objectContaining({ id: "support" }),
      ]),
    );
    const loaded = await callTool(transcript, "browse_blueprints", {
      blueprint: "crm",
    });
    const blueprint = (loaded.blueprints as Array<{ payload?: Record<string, unknown> }>)[0];
    if (!blueprint?.payload) throw new Error("CRM blueprint payload is missing");
    await callTool(transcript, "app_create", {
      intent:
        "Create the reviewed CRM app so accounts, contacts, deals, and activity share one governed workspace.",
      payload: blueprint.payload,
      risk_level: "high",
    });
    transcript.push({
      role: "assistant",
      text: "I prepared one CRM app proposal for your approval.",
    });

    expect(transcript.map((entry) => entry.role)).toEqual([
      "user",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(
      transcript.filter((entry) => entry.role === "tool").map((entry) => entry.name),
    ).toEqual(["browse_blueprints", "browse_blueprints", "app_create"]);
    expect(createActionRequest).toHaveBeenCalledTimes(1);
    expect(createActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        scope: "internal",
        kind: "app_create",
        status: "pending_approval",
        payload: expect.objectContaining({
          app: "crm",
          objects: expect.arrayContaining([
            expect.objectContaining({ api_name: "account" }),
            expect.objectContaining({ api_name: "opportunity" }),
          ]),
          permissions: expect.any(Array),
          pages: expect.any(Array),
        }),
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "action_request_emit",
        action_request_id: "request-crm",
        kind: "app_create",
        decision: "pending_approval",
      }),
    ]);
  });

  it("clarifies an ambiguous record update without proposing a mutation", async () => {
    const transcript: TranscriptEntry[] = [
      { role: "user", text: "Change Acme's industry to manufacturing." },
    ];
    const createActionRequest = vi.fn();
    const controlPlane = {
      listRecordCatalog: vi.fn(async () => ({
        apps: [
          {
            appId: "crm",
            objects: [{ apiName: "account", fields: [{ apiName: "industry" }] }],
          },
        ],
      })),
      findRecords: vi.fn(async () => ({
        rows: [
          { id: "account-1", name: "Acme Holdings", industry: "technology" },
          { id: "account-2", name: "Acme Europe", industry: "retail" },
        ],
        total: 2,
        cursor: null,
      })),
      evaluateActionPolicy: vi.fn(),
      createActionRequest,
    } as unknown as AgentControlPlane;

    buildRecordsReadServer({ orgId: "org-a", runId: "run-b", controlPlane });
    buildPluginActionServer({
      orgId: "org-a",
      threadId: "thread-b",
      runId: "run-b",
      descriptors: [actionDescriptor("record_update")],
      emit: vi.fn(),
      controlPlane,
    });

    await callTool(transcript, "browse_catalog", { app: "crm" });
    const matches = await callTool(transcript, "find_records", {
      app: "crm",
      object: "account",
      search: "Acme",
      first: 10,
    });
    const rows = matches.rows as Array<Record<string, unknown>>;
    if (rows.length !== 1) {
      transcript.push({
        role: "assistant",
        text: "I found Acme Holdings and Acme Europe. Which account should I update?",
      });
    }

    expect(transcript).toEqual([
      expect.objectContaining({ role: "user" }),
      expect.objectContaining({ role: "tool", name: "browse_catalog" }),
      expect.objectContaining({ role: "tool", name: "find_records" }),
      {
        role: "assistant",
        text: "I found Acme Holdings and Acme Europe. Which account should I update?",
      },
    ]);
    expect(sdk.tools.get("find_records")?.description).toMatch(
      /exact id.*disambiguate.*never guess/i,
    );
    expect(sdk.tools.has("record_update")).toBe(true);
    expect(controlPlane.evaluateActionPolicy).not.toHaveBeenCalled();
    expect(createActionRequest).not.toHaveBeenCalled();
  });
});
