/**
 * Entitlement gate for OpenNeko's open-core split. Enterprise features are
 * keyed strings stored comma-separated in organization.features (empty = the
 * free tier). OPENNEKO_FEATURES force-enables keys deployment-wide, ahead of
 * the signed-license-key path.
 */

import { organization } from "./schema";
import { db, eq } from "./index";
import { licensePublicKey, verifyLicense } from "./license";

export const FEATURE = {
  sso: "sso",
  approvalsPolicy: "approvals_policy",
  auditChain: "audit_chain",
  dualIdentityAudit: "dual_identity_audit",
  installPolicy: "install_policy",
  behavioralAlarms: "behavioral_alarms",
  securityProfiles: "security_profiles",
  vault: "vault",
  dataAccessGovernance: "data_access_governance",
  contextVersioning: "context_versioning",
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];

export function parseFeatures(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function envFeatures(): Set<string> {
  return parseFeatures(process.env.OPENNEKO_FEATURES);
}

let _licCache: { token: string; features: Set<string> } | null = null;

/** Features granted by a verified offline license token (OPENNEKO_LICENSE). */
function licenseFeatures(): Set<string> {
  const token = process.env.OPENNEKO_LICENSE ?? "";
  const pubkey = licensePublicKey();
  if (!token || !pubkey) return new Set();
  if (_licCache?.token !== token) {
    const lic = verifyLicense(token, pubkey, Math.floor(Date.now() / 1000));
    _licCache = { token, features: new Set(lic?.features ?? []) };
  }
  return _licCache.features;
}

/** Check a key against a raw organization.features value (+ env override). */
export function hasFeature(
  features: string | null | undefined,
  key: FeatureKey,
): boolean {
  return (
    parseFeatures(features).has(key) ||
    envFeatures().has(key) ||
    licenseFeatures().has(key)
  );
}

/** Resolve an org's entitlement from the DB (+ env override). */
export async function orgHasFeature(
  orgId: string,
  key: FeatureKey,
): Promise<boolean> {
  if (envFeatures().has(key) || licenseFeatures().has(key)) return true;
  const [row] = await db()
    .select({ features: organization.features })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  return parseFeatures(row?.features).has(key);
}
