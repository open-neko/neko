import { afterEach, describe, expect, it } from "vitest";
import { FEATURE, hasFeature, parseFeatures } from "../src/features";

const ORIG = process.env.OPENNEKO_FEATURES;
afterEach(() => {
  if (ORIG === undefined) delete process.env.OPENNEKO_FEATURES;
  else process.env.OPENNEKO_FEATURES = ORIG;
});

describe("parseFeatures", () => {
  it("is empty for null/empty", () => {
    expect(parseFeatures(null).size).toBe(0);
    expect(parseFeatures("").size).toBe(0);
  });
  it("splits, trims, and drops blanks", () => {
    expect([...parseFeatures(" sso , audit_chain ,, vault ")].sort()).toEqual([
      "audit_chain",
      "sso",
      "vault",
    ]);
  });
});

describe("hasFeature", () => {
  afterEach(() => delete process.env.OPENNEKO_FEATURES);

  it("matches a key present in the org features", () => {
    expect(hasFeature("sso,vault", FEATURE.sso)).toBe(true);
    expect(hasFeature("sso,vault", FEATURE.auditChain)).toBe(false);
  });
  it("treats empty features as the free tier", () => {
    delete process.env.OPENNEKO_FEATURES;
    expect(hasFeature("", FEATURE.sso)).toBe(false);
    expect(hasFeature(null, FEATURE.auditChain)).toBe(false);
  });
  it("force-enables via OPENNEKO_FEATURES deployment-wide", () => {
    process.env.OPENNEKO_FEATURES = "audit_chain";
    expect(hasFeature("", FEATURE.auditChain)).toBe(true);
    expect(hasFeature(null, FEATURE.sso)).toBe(false);
  });
});
