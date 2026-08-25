import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAGENTO_ANALYTICS_TABLES,
  readMagentoVersion,
  supportedMagentoDatabase,
} from "../src/packs/magento-preflight.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Magento version preflight", () => {
  it("keeps a host-gateway address when Magento redirects to localhost", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost:8080/magento_version" },
      }),
    );
    vi.stubGlobal("fetch", request);
    const hostHeaderRequest = vi
      .fn()
      .mockResolvedValue({ status: 200, text: "Magento/2.4 (Community)" });

    await expect(
      readMagentoVersion("http://host.docker.internal:8080", hostHeaderRequest),
    ).resolves.toBe("2.4.x");
    expect(hostHeaderRequest).toHaveBeenCalledWith(
      "http://host.docker.internal:8080/magento_version",
      "localhost:8080",
    );
  });

  it("rejects a version outside the supported 2.4 family", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("Magento/2.3.7", { status: 200 })));

    await expect(readMagentoVersion("https://store.example.com")).rejects.toThrow(
      "did not report a supported 2.4.x version",
    );
  });
});

describe("Magento database compatibility", () => {
  it("requires the operational customer and order support tables", () => {
    expect(MAGENTO_ANALYTICS_TABLES).toEqual(
      expect.arrayContaining([
        "customer_entity",
        "customer_address_entity",
        "sales_order_address",
        "sales_order_status_history",
        "sales_order_payment",
      ]),
    );
  });

  it("accepts the declared MariaDB and MySQL floors", () => {
    expect(supportedMagentoDatabase("10.6.18-MariaDB").type).toBe("mariadb");
    expect(supportedMagentoDatabase("8.0.39").type).toBe("mysql");
  });

  it("rejects versions below the manifest contract", () => {
    expect(() => supportedMagentoDatabase("10.5.27-MariaDB")).toThrow(/MariaDB 10\.6\+/);
    expect(() => supportedMagentoDatabase("5.7.44")).toThrow(/MySQL 8\.0\+/);
  });
});
