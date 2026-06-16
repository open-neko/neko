import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signLicense, verifyLicense } from "../src/license";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
const NOW = 1_000_000;

describe("license", () => {
  it("verifies a valid signed license", () => {
    const { pub, priv } = keypair();
    const token = signLicense(
      { customer: "Acme", features: ["sso", "audit_chain"], exp: NOW + 100 },
      priv,
    );
    expect(verifyLicense(token, pub, NOW)?.features).toEqual([
      "sso",
      "audit_chain",
    ]);
  });

  it("rejects an expired license", () => {
    const { pub, priv } = keypair();
    const token = signLicense(
      { customer: "Acme", features: ["sso"], exp: NOW - 1 },
      priv,
    );
    expect(verifyLicense(token, pub, NOW)).toBeNull();
  });

  it("rejects a signature from the wrong key", () => {
    const { priv } = keypair();
    const { pub: otherPub } = keypair();
    const token = signLicense(
      { customer: "Acme", features: ["sso"], exp: NOW + 100 },
      priv,
    );
    expect(verifyLicense(token, otherPub, NOW)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { pub, priv } = keypair();
    const token = signLicense(
      { customer: "Acme", features: ["sso"], exp: NOW + 100 },
      priv,
    );
    const forged =
      Buffer.from(
        JSON.stringify({
          customer: "Acme",
          features: ["sso", "audit_chain"],
          exp: NOW + 100,
        }),
      ).toString("base64url") +
      "." +
      token.split(".")[1];
    expect(verifyLicense(forged, pub, NOW)).toBeNull();
  });
});
