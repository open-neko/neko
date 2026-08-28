import { describe, expect, it } from "vitest";
import {
  classifyMagentoChange,
  evaluateMagentoCaps,
  isMagentoClassZeroOperation,
} from "../src/magento-v2.js";

describe("Magento V2 classifier", () => {
  it("defaults an unreviewed writable attribute to Class 1", () => {
    const result = classifyMagentoChange({
      domain: "catalog",
      entityType: "product",
      operationId: "magentoUpdateProduct",
      defaultClass: 2,
      body: { product: { name: "Known", future_magento_attribute: "unknown" } },
    });
    expect(result.riskClass).toBe(1);
    expect(result.reasons).toContain(
      "Unreviewed attribute future_magento_attribute defaults to Class 1",
    );
  });

  it("keeps reviewed reversible content in Class 2", () => {
    const result = classifyMagentoChange({
      domain: "content",
      entityType: "cms",
      operationId: "magentoUpdateCmsPage",
      defaultClass: 2,
      body: { page: { title: "Shipping", content: "Updated content", is_active: true } },
    });
    expect(result.riskClass).toBe(2);
    expect(result.attributes.every((attribute) => attribute.reviewed)).toBe(true);
  });

  it("recognizes Class 0 operation names before attribute routing", () => {
    expect(isMagentoClassZeroOperation("magentoOnlineRefund")).toBe(true);
    expect(isMagentoClassZeroOperation("magentoApproveReturn")).toBe(true);
    expect(isMagentoClassZeroOperation("magentoUpdateTaxConfig")).toBe(true);
    expect(classifyMagentoChange({
      domain: "orders",
      entityType: "order",
      operationId: "magentoOnlineRefund",
      defaultClass: 1,
      body: {},
    }).riskClass).toBe(0);
  });
});

describe("Magento V2 caps", () => {
  it("escalates a price move beyond the Class 2 delta cap", () => {
    const result = evaluateMagentoCaps({
      domain: "catalog",
      riskClass: 2,
      rows: [{
        beforeImage: { price: 100 },
        afterImage: { product: { price: 125 } },
      }],
      caps: { maxPriceDeltaPercent: 10 },
      now: new Date("2026-08-28T00:00:00.000Z"),
    });
    expect(result.allowed).toBe(true);
    expect(result.riskClass).toBe(1);
    expect(result.escalations[0]).toMatch(/25\.00%/);
  });

  it("rejects a near-free promotion and missing expiry", () => {
    const result = evaluateMagentoCaps({
      domain: "promotions",
      riskClass: 1,
      rows: [{ afterImage: { rule: { discount_amount: 100 } } }],
      projectedExposure: 100,
    });
    expect(result.allowed).toBe(false);
    expect(result.riskClass).toBe(0);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/free or near-free/i),
      "Promotion expiry is required",
    ]));
  });

  it("stops an automatic action at the daily cap or entity cooldown", () => {
    const result = evaluateMagentoCaps({
      domain: "inventory",
      riskClass: 2,
      rows: [{ afterImage: { sourceItems: [{ sku: "SKU-1", quantity: 4 }] } }],
      autoExecution: true,
      autoActionsToday: 5,
      cooldownBreaches: ["SKU-1:default"],
      caps: { maxDailyAutoActions: 5 },
    });
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringMatching(/daily automatic-action cap/i),
      "Cooldown is still active for SKU-1:default",
    ]));
  });

  it("does not coerce a missing exposure to zero", () => {
    expect(evaluateMagentoCaps({
      domain: "catalog",
      riskClass: 2,
      rows: [{ afterImage: { product: { name: "A" } } }],
      projectedExposure: null,
    }).projectedExposure).toBeNull();
  });
});
