import { createHash } from "node:crypto";
import {
  and,
  db,
  eq,
  records_watch_binding,
  records_watch_event_receipt,
  workflow_definition,
} from "@neko/db";
import {
  QUEUE,
  enqueue,
  type RecordsWatchEvaluatePayload,
} from "@neko/db/jobs";
import {
  buildRecordsStarterWatchDefinition,
  parseRecordsStarterWatchChoices,
  updateRecordsNativeWatchDelivery,
  upsertRecordsNativeWatch,
  type RecordsGraphjinTransport,
  type RecordsStarterWatchKey,
} from "@neko/records";

const STARTER_WORKFLOW_COPY: Record<
  RecordsStarterWatchKey,
  { name: string; description: string; goal: string }
> = {
  opportunities_without_activity: {
    name: "CRM · Opportunities with no activity",
    description: "Opportunities with no recorded activity in the last 30 days.",
    goal: "Surface stale opportunities early enough for an owner to follow up.",
  },
  unlinked_or_departed_owners: {
    name: "CRM · Unlinked or departed owners",
    description: "CRM ownership still attributed to an unlinked or inactive source user.",
    goal: "Keep imported CRM ownership accountable during and after cutover.",
  },
  deals_closing_this_month: {
    name: "CRM · Deals closing this month",
    description: "Open opportunities closing this month, grouped by owner.",
    goal: "Keep the current-month pipeline visible by accountable owner.",
  },
};

export type RecordsStarterWatchSeeder = (input: {
  orgId: string;
  appId: string;
  actionPayload: Record<string, unknown>;
}) => Promise<{ seeded: RecordsStarterWatchKey[] }>;

export function createRecordsStarterWatchSeeder(input: {
  graphjin: RecordsGraphjinTransport;
  token: (orgId: string) => string;
  webhookUrl?: string | null;
}): RecordsStarterWatchSeeder {
  return async ({ orgId, appId, actionPayload }) => {
    const choices = parseRecordsStarterWatchChoices(actionPayload).filter(
      (choice) => choice.enabled,
    );
    if (choices.length === 0) return { seeded: [] };
    const approvedActionHash = actionPayload.preview_hash;
    if (
      typeof approvedActionHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(approvedActionHash)
    ) {
      throw new Error("records starter watches require the approved app preview hash");
    }

    const seeded: RecordsStarterWatchKey[] = [];
    for (const choice of choices) {
      const definition = buildRecordsStarterWatchDefinition({
        orgId,
        appId,
        key: choice.key,
      });
      const native = await upsertRecordsNativeWatch({
        graphjin: input.graphjin,
        token: input.token(orgId),
        definition,
        webhookUrl: input.webhookUrl,
        approvedActionHash,
      });
      const copy = STARTER_WORKFLOW_COPY[choice.key];
      const [workflow] = await db()
        .insert(workflow_definition)
        .values({
          org_id: orgId,
          owner_user_id: "",
          name: copy.name,
          description: copy.description,
          goal: copy.goal,
          enabled: true,
          status: "active",
          cron_enabled: false,
          system_prompt_overlay:
            "Built-in records watcher. Its evaluator is deterministic and read-only; emit findings only from its governed result.",
        })
        .onConflictDoUpdate({
          target: [
            workflow_definition.org_id,
            workflow_definition.owner_user_id,
            workflow_definition.name,
          ],
          set: {
            description: copy.description,
            goal: copy.goal,
            enabled: true,
            status: "active",
            updated_at: new Date(),
          },
        })
        .returning({ id: workflow_definition.id });
      if (!workflow) throw new Error("failed to seed records starter workflow");
      await db()
        .insert(records_watch_binding)
        .values({
          org_id: orgId,
          app_id: appId,
          watch_key: choice.key,
          workflow_id: workflow.id,
          graphjin_watch_id: native.id,
          definition_hash: native.definitionHash,
          enabled: true,
          status: "active",
        })
        .onConflictDoUpdate({
          target: [
            records_watch_binding.org_id,
            records_watch_binding.app_id,
            records_watch_binding.watch_key,
          ],
          set: {
            workflow_id: workflow.id,
            graphjin_watch_id: native.id,
            definition_hash: native.definitionHash,
            enabled: true,
            status: "active",
            last_error: null,
            updated_at: new Date(),
          },
        });
      seeded.push(choice.key);
    }
    return { seeded };
  };
}

type EnqueueEvaluation = (
  payload: RecordsWatchEvaluatePayload,
  singletonKey: string,
) => Promise<unknown>;

const defaultEnqueueEvaluation: EnqueueEvaluation = (payload, singletonKey) =>
  enqueue(QUEUE.RECORDS_WATCH_EVALUATE, payload, {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    singletonKey,
    singletonHours: 24 * 8,
  });

export async function receiveRecordsNativeWatchEvent(
  input: {
    watchId: string;
    eventId: string;
    payload: Record<string, unknown>;
  },
  enqueueEvaluation: EnqueueEvaluation = defaultEnqueueEvaluation,
): Promise<{ accepted: boolean }> {
  const [binding] = await db()
    .select({
      id: records_watch_binding.id,
      orgId: records_watch_binding.org_id,
    })
    .from(records_watch_binding)
    .where(
      and(
        eq(records_watch_binding.graphjin_watch_id, input.watchId),
        eq(records_watch_binding.enabled, true),
        eq(records_watch_binding.status, "active"),
      ),
    )
    .limit(1);
  if (!binding) return { accepted: false };

  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.payload), "utf8")
    .digest("hex");
  await db()
    .insert(records_watch_event_receipt)
    .values({
      event_id: input.eventId,
      binding_id: binding.id,
      payload_hash: payloadHash,
    })
    .onConflictDoNothing({ target: records_watch_event_receipt.event_id });
  const [receipt] = await db()
    .select({
      payloadHash: records_watch_event_receipt.payload_hash,
      queuedAt: records_watch_event_receipt.queued_at,
    })
    .from(records_watch_event_receipt)
    .where(eq(records_watch_event_receipt.event_id, input.eventId))
    .limit(1);
  if (!receipt || receipt.payloadHash !== payloadHash) {
    throw new Error("records watch event id was replayed with different content");
  }
  if (receipt.queuedAt) return { accepted: false };

  await enqueueEvaluation(
    {
      orgId: binding.orgId,
      bindingId: binding.id,
      triggerKind: "gj_watch",
      eventId: input.eventId,
    },
    `records-watch-event:${input.eventId}`,
  );
  await db()
    .update(records_watch_event_receipt)
    .set({ queued_at: new Date() })
    .where(eq(records_watch_event_receipt.event_id, input.eventId));
  return { accepted: true };
}

export async function enqueueRecordsWatchFallbackSweep(
  orgId: string,
  enqueueEvaluation: EnqueueEvaluation = defaultEnqueueEvaluation,
): Promise<number> {
  const bindings = await db()
    .select({ id: records_watch_binding.id })
    .from(records_watch_binding)
    .where(
      and(
        eq(records_watch_binding.org_id, orgId),
        eq(records_watch_binding.enabled, true),
        eq(records_watch_binding.status, "active"),
      ),
    );
  for (const binding of bindings) {
    const cadenceBucket = Math.floor(Date.now() / (15 * 60 * 1_000));
    await enqueueEvaluation(
      {
        orgId,
        bindingId: binding.id,
        triggerKind: "schedule",
      },
      `records-watch-schedule:${binding.id}:${cadenceBucket}`,
    );
  }
  return bindings.length;
}

export async function reconcileRecordsNativeWatchDeliveries(input: {
  graphjin: RecordsGraphjinTransport;
  token: (orgId: string) => string;
  webhookUrl?: string | null;
}): Promise<number> {
  const bindings = await db()
    .select({
      orgId: records_watch_binding.org_id,
      watchId: records_watch_binding.graphjin_watch_id,
    })
    .from(records_watch_binding)
    .where(
      and(
        eq(records_watch_binding.enabled, true),
        eq(records_watch_binding.status, "active"),
      ),
    );
  for (const binding of bindings) {
    await updateRecordsNativeWatchDelivery({
      graphjin: input.graphjin,
      token: input.token(binding.orgId),
      watchId: binding.watchId,
      webhookUrl: input.webhookUrl,
    });
  }
  return bindings.length;
}
