import { createHash } from "node:crypto";
import { validateRecordIdentifier } from "../naming";
import type { JsonObject } from "../types";
import type { RecordsGraphjinTransport } from "../graphjin/client";

export const RECORDS_STARTER_WATCH_KEYS = [
  "opportunities_without_activity",
  "unlinked_or_departed_owners",
  "deals_closing_this_month",
] as const;

export type RecordsStarterWatchKey =
  (typeof RECORDS_STARTER_WATCH_KEYS)[number];

export type RecordsStarterWatchChoice = {
  key: RecordsStarterWatchKey;
  enabled: boolean;
};

export type RecordsNativeWatchDefinition = {
  key: RecordsStarterWatchKey;
  name: string;
  description: string;
  query: string;
  definitionHash: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRecordsStarterWatchChoices(
  payload: Record<string, unknown>,
): RecordsStarterWatchChoice[] {
  if (payload.starter_workflows === undefined) return [];
  if (!Array.isArray(payload.starter_workflows)) {
    throw new Error("starter_workflows must be an array");
  }
  const choices = payload.starter_workflows.map((value, index) => {
    if (!isObject(value)) {
      throw new Error(`starter_workflows[${index}] must be an object`);
    }
    if (
      typeof value.key !== "string" ||
      !RECORDS_STARTER_WATCH_KEYS.includes(value.key as RecordsStarterWatchKey)
    ) {
      throw new Error(`starter_workflows[${index}].key is unsupported`);
    }
    if (typeof value.enabled !== "boolean") {
      throw new Error(`starter_workflows[${index}].enabled must be boolean`);
    }
    return {
      key: value.key as RecordsStarterWatchKey,
      enabled: value.enabled,
    };
  });
  if (new Set(choices.map((choice) => choice.key)).size !== choices.length) {
    throw new Error("starter_workflows contains duplicate keys");
  }
  return choices;
}

function watchHash(value: Omit<RecordsNativeWatchDefinition, "definitionHash">): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export function buildRecordsStarterWatchDefinition(input: {
  orgId: string;
  appId: string;
  key: RecordsStarterWatchKey;
}): RecordsNativeWatchDefinition {
  const appId = validateRecordIdentifier(input.appId);
  if (!input.orgId.trim()) throw new Error("records starter watch requires an org id");
  if (appId !== "crm") {
    throw new Error(`records starter watch ${input.key} requires the CRM blueprint`);
  }
  const prefix = `openneko_${input.orgId}_${appId}`.replace(/[^A-Za-z0-9_]/g, "_");
  let definition: Omit<RecordsNativeWatchDefinition, "definitionHash">;
  if (input.key === "opportunities_without_activity") {
    definition = {
      key: input.key,
      name: `${prefix}_opportunities_without_activity`,
      description:
        "Wake OpenNeko when governed CRM changes arrive; the evaluator detects opportunities with no activity in 30 days.",
      query: `subscription RecordsOpportunitiesWithoutActivity($record_change_log_cursor: Cursor) { record_change_log(first: 100, after: $record_change_log_cursor, order_by: { at: asc, id: asc }) { id app_id object_api_name record_id action at } record_change_log_cursor }`,
    };
  } else if (input.key === "unlinked_or_departed_owners") {
    definition = {
      key: input.key,
      name: `${prefix}_unlinked_or_departed_owners`,
      description:
        "Wake OpenNeko when CRM source identity mappings change so unlinked or departed owners are surfaced.",
      query: `subscription RecordsUnlinkedOrDepartedOwners($identity_map_cursor: Cursor) { identity_map(first: 100, after: $identity_map_cursor, order_by: { updated_at: asc }) { source_instance_id app_id source_user_id source_is_active app_user_id status updated_at } identity_map_cursor }`,
    };
  } else {
    definition = {
      key: input.key,
      name: `${prefix}_deals_closing_this_month`,
      description:
        "Wake OpenNeko when governed CRM changes arrive; the evaluator groups this month's closing deals by owner.",
      query: `subscription RecordsDealsClosingThisMonth($record_change_log_cursor: Cursor) { record_change_log(first: 100, after: $record_change_log_cursor, order_by: { at: asc, id: asc }) { id app_id object_api_name record_id action at } record_change_log_cursor }`,
    };
  }
  return { ...definition, definitionHash: watchHash(definition) };
}

function gqlValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(gqlValue).join(", ")}]`;
  if (isObject(value)) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`invalid GraphQL input key: ${key}`);
        }
        return `${key}: ${gqlValue(entry)}`;
      })
      .join(", ")} }`;
  }
  throw new Error("unsupported GraphQL input value");
}

function firstRow(value: unknown, root: string): Record<string, unknown> | null {
  if (!isObject(value)) return null;
  const candidate = value[root];
  if (Array.isArray(candidate)) {
    return isObject(candidate[0]) ? candidate[0] : null;
  }
  return isObject(candidate) ? candidate : null;
}

export async function upsertRecordsNativeWatch(input: {
  graphjin: RecordsGraphjinTransport;
  token: string;
  definition: RecordsNativeWatchDefinition;
  webhookUrl?: string | null;
  approvedActionHash: string;
}): Promise<{ id: string; definitionHash: string }> {
  const existing = await input.graphjin.execute<Record<string, unknown>>({
    operationName: "FindRecordsNativeWatch",
    query: `query FindRecordsNativeWatch { gj_watch(where: { name: { eq: ${JSON.stringify(input.definition.name)} } }, limit: 1) { id name } }`,
    token: input.token,
  });
  const row = firstRow(existing, "gj_watch");
  const watchInput: JsonObject = {
    name: input.definition.name,
    description: input.definition.description,
    query: input.definition.query,
    variables_json: {},
    evidence_json: {
      producer: "openneko-records-starter-watch",
      definition_hash: input.definition.definitionHash,
      approved_action_hash: input.approvedActionHash,
    },
    lifecycle: "durable",
    status: "active",
    approval: "approved",
    enabled: true,
    ...(input.webhookUrl
      ? {
          delivery_json: {
            kind: "webhook",
            url: input.webhookUrl,
            secret_env: "OPENNEKO_RECORDS_WATCH_WEBHOOK_SECRET",
          },
        }
      : { delivery_json: { kind: "inbox" } }),
  };
  const selector =
    typeof row?.id === "string"
      ? `where: { id: { eq: ${JSON.stringify(row.id)} } }, update: ${gqlValue(watchInput)}`
      : `insert: ${gqlValue(watchInput)}`;
  const changed = await input.graphjin.execute<Record<string, unknown>>({
    operationName: "UpsertRecordsNativeWatch",
    query: `mutation UpsertRecordsNativeWatch { gj_watch(${selector}) { id name status approval enabled } }`,
    token: input.token,
  });
  const updated = firstRow(changed, "gj_watch");
  if (typeof updated?.id !== "string" || !updated.id) {
    throw new Error("GraphJin did not return the native watch id");
  }
  return { id: updated.id, definitionHash: input.definition.definitionHash };
}

/** Rebind a durable watch after worker/container addressing changes. */
export async function updateRecordsNativeWatchDelivery(input: {
  graphjin: RecordsGraphjinTransport;
  token: string;
  watchId: string;
  webhookUrl?: string | null;
}): Promise<void> {
  if (!input.watchId.trim()) throw new Error("records native watch id is required");
  const delivery: JsonObject = input.webhookUrl
    ? {
        kind: "webhook",
        url: input.webhookUrl,
        secret_env: "OPENNEKO_RECORDS_WATCH_WEBHOOK_SECRET",
      }
    : { kind: "inbox" };
  const changed = await input.graphjin.execute<Record<string, unknown>>({
    operationName: "UpdateRecordsNativeWatchDelivery",
    query: `mutation UpdateRecordsNativeWatchDelivery { gj_watch(where: { id: { eq: ${JSON.stringify(input.watchId)} } }, update: { delivery_json: ${gqlValue(delivery)} }) { id } }`,
    token: input.token,
  });
  const updated = firstRow(changed, "gj_watch");
  if (updated?.id !== input.watchId) {
    throw new Error("GraphJin did not confirm the native watch delivery update");
  }
}
