import { describe, expect, it } from "vitest";
import { durablePackTables } from "../src/packs/graphjin-config";

describe("pack GraphJin config persistence", () => {
  it("keeps the live source-resolution hint out of durable YAML", () => {
    expect(durablePackTables([
      {
        name: "sales_order",
        source: "magento_analytics",
        database: "magento_analytics",
        read_only: true,
      },
      {
        name: "legacy_table",
        database: "legacy_database",
      },
    ])).toEqual([
      {
        name: "sales_order",
        source: "magento_analytics",
        read_only: true,
      },
      {
        name: "legacy_table",
        database: "legacy_database",
      },
    ]);
  });
});
