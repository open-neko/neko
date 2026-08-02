import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, app_state, db, eq } from "@neko/db";
import {
  createTestOrg,
  dbReachable,
  deleteTestOrg,
  uniqueOrgId,
} from "@neko/db/test-helpers";
import {
  enableSalesforceSync,
  getSalesforceSyncState,
  mirrorSalesforceSyncWatermarks,
  SalesforceSyncStateError,
  updateSalesforceSyncState,
} from "../../src/records/salesforce-sync-state.js";

const reachable = await dbReachable();
const describeIfDb = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("[salesforce-sync-state] skipping: Postgres unreachable.");
}

describeIfDb("Salesforce sync metadata lifecycle", () => {
  let orgId: string;

  beforeEach(async () => {
    orgId = uniqueOrgId("salesforce-sync-state");
    await createTestOrg(orgId);
    await db().insert(app_state).values({
      org_id: orgId,
      app_id: "crm",
      status: "active",
      config: {
        mode: "mirror",
        connector: {
          kind: "salesforce",
          source_instance_id: "salesforce-production",
          export_action_request_id: "00000000-0000-4000-a000-000000000871",
          retained_metadata: "preserve-me",
          objects: [
            {
              source_api_name: "Account",
              object_api_name: "account",
              watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
            },
          ],
        },
      },
    });
  });

  afterEach(async () => {
    await deleteTestOrg(orgId);
  });

  it("enables and advances a schedule without replacing connector metadata", async () => {
    const enabled = await enableSalesforceSync(orgId, "crm", 30);
    expect(enabled).toMatchObject({
      orgId,
      appId: "crm",
      enabled: true,
      intervalMinutes: 30,
      status: "queued",
    });
    await updateSalesforceSyncState(enabled, {
      status: "succeeded",
      lastCompletedAt: "2026-08-02T12:30:00.000Z",
      lastError: null,
      apiBudget: { day: "2026-08-02", used: 17, limit: 10_000 },
    });
    await mirrorSalesforceSyncWatermarks(enabled, [
      {
        sourceApiName: "Account",
        objectApiName: "account",
        watermark: { system_modstamp: "2026-08-02T12:30:00.000Z" },
      },
    ]);

    const state = await getSalesforceSyncState(orgId, "crm");
    expect(state).toMatchObject({
      status: "succeeded",
      lastCompletedAt: "2026-08-02T12:30:00.000Z",
      apiBudget: { day: "2026-08-02", used: 17, limit: 10_000 },
      objects: [
        {
          sourceApiName: "Account",
          objectApiName: "account",
          watermark: { system_modstamp: "2026-08-02T12:30:00.000Z" },
        },
      ],
    });
    const rows = await db()
      .select({ config: app_state.config })
      .from(app_state)
      .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, "crm")));
    expect(rows[0]?.config).toMatchObject({
      connector: { retained_metadata: "preserve-me" },
    });
  });

  it("rejects enablement after primary cutover", async () => {
    await db()
      .update(app_state)
      .set({
        config: {
          mode: "primary",
          connector: {
            kind: "salesforce",
            source_instance_id: "salesforce-production",
            export_action_request_id: "00000000-0000-4000-a000-000000000871",
            objects: [
              {
                source_api_name: "Account",
                object_api_name: "account",
                watermark: { system_modstamp: "2026-08-02T12:00:00.000Z" },
              },
            ],
          },
        },
      })
      .where(and(eq(app_state.org_id, orgId), eq(app_state.app_id, "crm")));
    await expect(enableSalesforceSync(orgId, "crm", 15)).rejects.toBeInstanceOf(
      SalesforceSyncStateError,
    );
  });
});
