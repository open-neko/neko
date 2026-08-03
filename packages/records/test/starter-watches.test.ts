import { describe, expect, it, vi } from "vitest";
import {
  buildRecordsStarterWatchDefinition,
  parseRecordsStarterWatchChoices,
  updateRecordsNativeWatchDelivery,
  upsertRecordsNativeWatch,
} from "../src/watchers/starter";

describe("records starter watches", () => {
  it("requires an explicit enabled choice and rejects duplicates", () => {
    expect(parseRecordsStarterWatchChoices({})).toEqual([]);
    expect(
      parseRecordsStarterWatchChoices({
        starter_workflows: [
          { key: "opportunities_without_activity", enabled: true },
          { key: "deals_closing_this_month", enabled: false },
        ],
      }),
    ).toEqual([
      { key: "opportunities_without_activity", enabled: true },
      { key: "deals_closing_this_month", enabled: false },
    ]);
    expect(() =>
      parseRecordsStarterWatchChoices({
        starter_workflows: [
          { key: "deals_closing_this_month", enabled: true },
          { key: "deals_closing_this_month", enabled: false },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("builds stable cursor-backed native subscriptions for all CRM seeds", () => {
    const stale = buildRecordsStarterWatchDefinition({
      orgId: "org-a",
      appId: "crm",
      key: "opportunities_without_activity",
    });
    const owners = buildRecordsStarterWatchDefinition({
      orgId: "org-a",
      appId: "crm",
      key: "unlinked_or_departed_owners",
    });
    const closing = buildRecordsStarterWatchDefinition({
      orgId: "org-a",
      appId: "crm",
      key: "deals_closing_this_month",
    });

    expect(stale.query).toContain("$record_change_log_cursor: Cursor");
    expect(stale.query).toContain("record_change_log_cursor");
    expect(owners.query).toContain("identity_map_cursor");
    expect(closing.query).toContain("record_change_log_cursor");
    for (const definition of [stale, owners, closing]) {
      expect(definition.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("creates an approved HMAC webhook watch and updates it idempotently", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ gj_watch: [] })
      .mockResolvedValueOnce({
        gj_watch: [{ id: "native-watch-1", status: "active", approval: "approved" }],
      });
    const definition = buildRecordsStarterWatchDefinition({
      orgId: "org-a",
      appId: "crm",
      key: "deals_closing_this_month",
    });
    await expect(
      upsertRecordsNativeWatch({
        graphjin: { execute },
        token: "watch-token",
        definition,
        webhookUrl: "http://172.20.0.8:4100/admin/events/records-watch",
        approvedActionHash: "a".repeat(64),
      }),
    ).resolves.toEqual({
      id: "native-watch-1",
      definitionHash: definition.definitionHash,
    });
    const mutation = execute.mock.calls[1]![0].query as string;
    expect(mutation).toContain("insert:");
    expect(mutation).toContain('approval: "approved"');
    expect(mutation).toContain("OPENNEKO_RECORDS_WATCH_WEBHOOK_SECRET");
    expect(mutation).toContain("approved_action_hash");
  });

  it("rebinds a durable watch without changing its approved query", async () => {
    const execute = vi.fn().mockResolvedValue({
      gj_watch: [{ id: "native-watch-1" }],
    });
    await updateRecordsNativeWatchDelivery({
      graphjin: { execute },
      token: "watch-service-token",
      watchId: "native-watch-1",
      webhookUrl: "http://172.20.0.9:4100/admin/events/records-watch",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: "UpdateRecordsNativeWatchDelivery",
        query: expect.stringContaining(
          'url: "http://172.20.0.9:4100/admin/events/records-watch"',
        ),
      }),
    );
    expect(execute.mock.calls[0]?.[0].query).not.toContain("query:");
  });
});
