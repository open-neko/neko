import { describe, expect, it } from "vitest";
import { nativeArtifactStateHash } from "../src/packs/artifact-state";

describe("pack materialized state", () => {
  it("ignores database timestamps but detects managed metric edits", () => {
    const original = {
      role: "owner",
      slug: "orders",
      title: "Orders",
      active: true,
      updated_at: new Date("2026-01-01"),
    };
    expect(nativeArtifactStateHash("metric", {
      ...original,
      updated_at: new Date("2026-08-20"),
    })).toBe(nativeArtifactStateHash("metric", original));
    expect(nativeArtifactStateHash("metric", {
      ...original,
      title: "Orders edited by user",
    })).not.toBe(nativeArtifactStateHash("metric", original));
  });
});
