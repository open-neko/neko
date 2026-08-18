import { describe, expect, it } from "vitest";
import { triageUpload } from "../src/library/triage";

describe("triageUpload", () => {
  it("distills knowledge-shaped extensions", () => {
    for (const filename of ["policy.pdf", "notes.md", "contract.docx", "page.html"]) {
      expect(triageUpload({ filename, size: 5_000_000 }).action).toBe("distill");
    }
  });

  it("skips large data-shaped files", () => {
    const decision = triageUpload({ filename: "orders.csv", size: 2_000_000 });
    expect(decision.action).toBe("skip");
  });

  it("skips unsupported extensions", () => {
    expect(triageUpload({ filename: "archive.zip", size: 10 }).action).toBe("skip");
    expect(triageUpload({ filename: "noext", size: 10 }).action).toBe("skip");
  });

  it("distills a small data-shaped file that reads as prose", () => {
    const sample = [
      "Our refund policy allows customers to request refunds within 30 days.",
      "Any refund above five hundred dollars requires CFO approval first.",
      "Store credit is offered when the original payment method has expired.",
    ].join("\n");
    expect(
      triageUpload({ filename: "policy-notes.json", size: 400, sample }).action,
    ).toBe("distill");
  });

  it("skips a small data-shaped file that reads as tabular data", () => {
    const sample = [
      "order_id,customer_id,total",
      "1001,c-1,25.00",
      "1002,c-2,110.50",
      "1003,c-3,9.99",
    ].join("\n");
    expect(
      triageUpload({ filename: "orders.csv", size: 400, sample }).action,
    ).toBe("skip");
  });

  it("skips a small data file with no sample to judge", () => {
    expect(triageUpload({ filename: "data.json", size: 400 }).action).toBe("skip");
  });
});
