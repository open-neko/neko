/**
 * Offline license tokens. A license is a small JSON payload (customer,
 * features, exp) signed with an Ed25519 private key held by the vendor and
 * verified locally against the public key — no network call, air-gap friendly.
 * Set the public key via OPENNEKO_LICENSE_PUBKEY or by replacing
 * EMBEDDED_LICENSE_PUBKEY at build time; mint tokens with scripts/sign-license.ts.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export type License = {
  customer: string;
  features: string[];
  /** Expiry, epoch seconds. */
  exp: number;
};

/** Replace with your Ed25519 public key (SPKI PEM), or set OPENNEKO_LICENSE_PUBKEY. */
export const EMBEDDED_LICENSE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAXKeJVuIQjUYPUbwtxYyKTBvvuJKvZdLdkcd0gGefpfU=
-----END PUBLIC KEY-----
`;

export function licensePublicKey(): string {
  return process.env.OPENNEKO_LICENSE_PUBKEY || EMBEDDED_LICENSE_PUBKEY;
}

export function signLicense(license: License, privateKeyPem: string): string {
  const seg = Buffer.from(JSON.stringify(license)).toString("base64url");
  const sig = sign(null, Buffer.from(seg), createPrivateKey(privateKeyPem));
  return `${seg}.${sig.toString("base64url")}`;
}

export function verifyLicense(
  token: string,
  publicKeyPem: string,
  nowSec: number,
): License | null {
  if (!token || !publicKeyPem) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const seg = token.slice(0, dot);
  const sigSeg = token.slice(dot + 1);
  try {
    const ok = verify(
      null,
      Buffer.from(seg),
      createPublicKey(publicKeyPem),
      Buffer.from(sigSeg, "base64url"),
    );
    if (!ok) return null;
    const license = JSON.parse(
      Buffer.from(seg, "base64url").toString("utf8"),
    ) as License;
    if (
      typeof license.exp !== "number" ||
      license.exp < nowSec ||
      !Array.isArray(license.features)
    ) {
      return null;
    }
    return license;
  } catch {
    return null;
  }
}
