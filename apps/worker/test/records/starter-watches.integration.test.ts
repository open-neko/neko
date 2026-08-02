import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, records_watch_binding } from "@neko/db";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import type { RecordsGraphjinTransport } from "@neko/records";
import { createRecordsWatchEvaluator } from "../../src/jobs/records-watch-evaluate.js";
import {
  createRecordsStarterWatchSeeder,
  enqueueRecordsWatchFallbackSweep,
  reconcileRecordsNativeWatchDeliveries,
  receiveRecordsNativeWatchEvent,
} from "../../src/records/starter-watches.js";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[starter-watches] skipping: Postgres unreachable.");
}

describeIfDb("records starter watch lifecycle", () => {
  let orgId: string;
  const graphjinWatchId = "00000000-0000-4000-a000-000000000912";

  beforeEach(async () => {
    orgId = uniqueOrgId("starter-watch");
    await createTestOrg(orgId);
  });

  afterEach(async () => {
    await deleteTestOrg(orgId);
    vi.clearAllMocks();
  });

  async function seedOneWatch() {
    const graphjin: RecordsGraphjinTransport = {
      async execute<T>(input): Promise<T> {
        if (input.operationName === "FindRecordsNativeWatch") {
          return { gj_watch: [] } as T;
        }
        if (input.operationName === "UpsertRecordsNativeWatch") {
          return {
            gj_watch: [
              {
                id: graphjinWatchId,
                name: "watch",
                status: "active",
                approval: "approved",
                enabled: true,
              },
            ],
          } as T;
        }
        throw new Error(`unexpected operation ${input.operationName}`);
      },
    };
    const seed = createRecordsStarterWatchSeeder({
      graphjin,
      token: () => "watch-service-token",
      webhookUrl: "http://172.19.0.5:4100/admin/events/records-watch",
    });
    await expect(
      seed({
        orgId,
        appId: "crm",
        actionPayload: {
          preview_hash: "a".repeat(64),
          starter_workflows: [
            { key: "opportunities_without_activity", enabled: true },
            { key: "deals_closing_this_month", enabled: false },
          ],
        },
      }),
    ).resolves.toEqual({ seeded: ["opportunities_without_activity"] });
    const [binding] = await db()
      .select()
      .from(records_watch_binding)
      .where(eq(records_watch_binding.graphjin_watch_id, graphjinWatchId));
    expect(binding).toMatchObject({
      org_id: orgId,
      app_id: "crm",
      watch_key: "opportunities_without_activity",
      status: "active",
      enabled: true,
    });
    return binding!;
  }

  it("persists a native event receipt once and schedules the fallback path", async () => {
    const binding = await seedOneWatch();
    const enqueued = vi.fn(async () => "job-id");

    await expect(
      receiveRecordsNativeWatchEvent(
        { watchId: graphjinWatchId, eventId: "event-1", payload: { changed: 1 } },
        enqueued,
      ),
    ).resolves.toEqual({ accepted: true });
    await expect(
      receiveRecordsNativeWatchEvent(
        { watchId: graphjinWatchId, eventId: "event-1", payload: { changed: 1 } },
        enqueued,
      ),
    ).resolves.toEqual({ accepted: false });
    expect(enqueued).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveBeenCalledWith(
      {
        orgId,
        bindingId: binding.id,
        triggerKind: "gj_watch",
        eventId: "event-1",
      },
      "records-watch-event:event-1",
    );

    const scheduled = vi.fn(async () => "job-id");
    await expect(enqueueRecordsWatchFallbackSweep(orgId, scheduled)).resolves.toBe(1);
    expect(scheduled).toHaveBeenCalledWith(
      { orgId, bindingId: binding.id, triggerKind: "schedule" },
      expect.stringMatching(new RegExp(`^records-watch-schedule:${binding.id}:\\d+$`)),
    );

    const rebind = vi.fn(async () => ({ gj_watch: [{ id: graphjinWatchId }] }));
    await expect(
      reconcileRecordsNativeWatchDeliveries({
        graphjin: { execute: rebind },
        token: () => "watch-service-token",
        webhookUrl: "http://172.19.0.8:4100/admin/events/records-watch",
      }),
    ).resolves.toBe(1);
    expect(rebind).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "UpdateRecordsNativeWatchDelivery",
        token: "watch-service-token",
      }),
    );
  });

  it("runs the same deterministic evaluator for native and scheduled triggers", async () => {
    const binding = await seedOneWatch();
    const graphjin: RecordsGraphjinTransport = {
      async execute<T>(input): Promise<T> {
        expect(input.operationName).toBe("EvaluateRecordsStaleOpportunities");
        expect(input.variables).toEqual({ cutoff: "2026-07-03T12:00:00.000Z" });
        return {
          opportunities: [
            {
              id: "opportunity-1",
              name: "Needs attention",
              owner_user_id: "owner-1",
              stage: "proposal",
              close_date: "2026-08-20",
            },
          ],
          activities: [],
        } as T;
      },
    };
    const publish = vi.fn(async () => undefined);
    const evaluate = createRecordsWatchEvaluator({
      graphjin,
      token: () => "watch-service-token",
      now: () => new Date("2026-08-02T12:00:00.000Z"),
      publish,
    });

    await expect(
      evaluate({
        orgId,
        bindingId: binding.id,
        triggerKind: "gj_watch",
        eventId: "event-2",
      }),
    ).resolves.toEqual({ findings: 1 });
    await expect(
      evaluate({ orgId, bindingId: binding.id, triggerKind: "schedule" }),
    ).resolves.toEqual({ findings: 1 });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      orgId,
      workflowId: binding.workflow_id,
      triggerKind: "watcher",
      triggerPayload: { eventId: "event-2" },
      finding: { topic: "opportunities_without_activity", mood: "act" },
    });
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      orgId,
      workflowId: binding.workflow_id,
      triggerKind: "schedule",
      finding: { topic: "opportunities_without_activity", mood: "act" },
    });
  });
});
