import { describe, expect, it } from "vitest";
import { resolveRecordsWatchWebhookUrl } from "../../src/records/schema-runtime.js";

describe("records watch webhook URL", () => {
  it("accepts only the exact configured ingress route", () => {
    expect(
      resolveRecordsWatchWebhookUrl(
        {
          OPENNEKO_RECORDS_WATCH_WEBHOOK_URL:
            "https://records.example.test/admin/events/records-watch",
        },
        {},
      ),
    ).toBe("https://records.example.test/admin/events/records-watch");

    for (const value of [
      "ftp://records.example.test/admin/events/records-watch",
      "https://records.example.test/admin/events/records-watch?token=unsafe",
      "https://records.example.test/admin/events/records-watch/",
      "https://records.example.test/another-route",
    ]) {
      expect(() =>
        resolveRecordsWatchWebhookUrl(
          { OPENNEKO_RECORDS_WATCH_WEBHOOK_URL: value },
          {},
        ),
      ).toThrow(/records watch webhook URL/);
    }
  });

  it("chooses a deterministic literal non-loopback IPv4 address", () => {
    expect(
      resolveRecordsWatchWebhookUrl(
        {},
        {
          zeta: [
            {
              address: "fd00::9",
              netmask: "ffff:ffff:ffff:ffff::",
              family: "IPv6",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "fd00::9/64",
              scopeid: 0,
            },
          ],
          alpha: [
            {
              address: "127.0.0.1",
              netmask: "255.0.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: true,
              cidr: "127.0.0.1/8",
            },
            {
              address: "172.19.0.5",
              netmask: "255.255.0.0",
              family: "IPv4",
              mac: "00:00:00:00:00:00",
              internal: false,
              cidr: "172.19.0.5/16",
            },
          ],
        },
      ),
    ).toBe("http://172.19.0.5:4100/admin/events/records-watch");
    expect(resolveRecordsWatchWebhookUrl({}, {})).toBeNull();
  });
});
