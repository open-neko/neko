import { describe, expect, it } from "vitest";
import { withoutAutoApprove } from "../src/workflows/policy-gate";
import type { PolicyDecision } from "../src/workflows/policy-engine";

const policy = { name: "p" } as PolicyDecision extends { policy: infer P }
  ? P
  : never;

describe("withoutAutoApprove", () => {
  it("downgrades an auto-approve allow to manual approval, preserving the policy", () => {
    const d = withoutAutoApprove({
      decision: "allow",
      policy,
      mode: "auto_approve",
    });
    expect(d.decision).toBe("needs_approval");
    if (d.decision === "needs_approval") {
      expect(d.mode).toBe("approval_required");
      expect(d.policy).toBe(policy);
    }
  });

  it("leaves non-allow decisions unchanged", () => {
    const np: PolicyDecision = {
      decision: "no_policy",
      reason: "no_matching_policy",
    };
    expect(withoutAutoApprove(np)).toBe(np);
  });
});
