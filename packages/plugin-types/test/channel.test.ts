import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/define-plugin.js";
import { dispatchPluginRpc } from "../src/runner.js";
import { PluginManifestEntry } from "../src/manifest.js";
import type { CapabilityProfile, DeliverParams } from "../src/channel.js";

const profile: CapabilityProfile = {
  modalities: ["text"],
  richMedia: { markdown: false, cards: false, charts: false, images: true, interactiveControls: true },
  interaction: { turnTaking: "async", canApproveInline: true, quickReplies: true },
  constraints: { maxOutboundChars: 1024, latencyClass: "interactive", attentionModel: "push" },
  fidelity: "summary",
};

const plugin = definePlugin({
  name: "@open-neko/channel-telegram",
  version: "0.1.0",
  capabilities: {
    channel: {
      providerLabel: "Telegram",
      profile,
      directions: ["inbound", "outbound"],
      ingress: "webhook",
      deliver: (p) => ({ delivered: true, ref: `msg.${p.events.length}` }),
      parseInbound: (p) => ({ intents: [{ kind: "utterance", text: String((p.raw as { text?: string }).text ?? "") }] }),
      verifyInbound: (p) => ({ ok: p.headers["x-hub-signature-256"] === "sha256=valid" }),
    },
  },
});

const resultOf = (res: { ok: boolean; result?: unknown }): Record<string, unknown> =>
  (res.result ?? {}) as Record<string, unknown>;

describe("channel capability over the plugin RPC", () => {
  it("register() reports the channel declaration", async () => {
    const res = await dispatchPluginRpc(plugin, { method: "register", paramsJson: "{}" });
    expect(res.ok).toBe(true);
    const caps = (resultOf(res).capabilities as { channel: Record<string, unknown> }).channel;
    expect(caps.providerLabel).toBe("Telegram");
    expect(caps.directions).toEqual(["inbound", "outbound"]);
    expect(caps.ingress).toBe("webhook");
  });

  it("deliver projects and returns a delivery ref", async () => {
    const params: DeliverParams = { recipient: { kind: "telegram", chatId: 7 }, events: [{}, {}], profile };
    const res = await dispatchPluginRpc(plugin, { method: "deliver", paramsJson: JSON.stringify(params) });
    expect(res).toMatchObject({ ok: true, result: { delivered: true, ref: "msg.2" } });
  });

  it("parse_inbound normalizes a raw payload to intents", async () => {
    const res = await dispatchPluginRpc(plugin, {
      method: "parse_inbound",
      paramsJson: JSON.stringify({ raw: { text: "approve it" } }),
    });
    expect(res).toMatchObject({ ok: true, result: { intents: [{ kind: "utterance", text: "approve it" }] } });
  });

  it("verify_inbound checks the signature using the in-VM secret", async () => {
    const good = await dispatchPluginRpc(plugin, {
      method: "verify_inbound",
      paramsJson: JSON.stringify({ headers: { "x-hub-signature-256": "sha256=valid" }, body: "{}" }),
    });
    expect(good).toMatchObject({ ok: true, result: { ok: true } });
    const bad = await dispatchPluginRpc(plugin, {
      method: "verify_inbound",
      paramsJson: JSON.stringify({ headers: {}, body: "{}" }),
    });
    expect(bad).toMatchObject({ ok: true, result: { ok: false } });
  });

  it("a manifest entry may declare capabilities.channel", () => {
    const parsed = PluginManifestEntry.safeParse({
      name: "@open-neko/channel-telegram",
      version: "0.1.0",
      integrity: `sha512-${"A".repeat(8)}`,
      permissions: {
        network: ["api.telegram.org"],
        env: [{ key: "TELEGRAM_TOKEN", description: "Telegram Bot API token" }],
      },
      capabilities: {
        channel: { providerLabel: "Telegram", profile, directions: ["outbound"], ingress: "webhook" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("definePlugin rejects a channel without a deliver handler", () => {
    expect(() =>
      definePlugin({
        name: "@open-neko/channel-broken",
        version: "0.1.0",
        capabilities: { channel: { providerLabel: "X", profile, directions: ["outbound"] } as never },
      }),
    ).toThrow(/deliver/);
  });
});
