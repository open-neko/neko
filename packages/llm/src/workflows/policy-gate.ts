import { FEATURE, orgHasFeature } from "@neko/db";
import type { PolicyDecision } from "./policy-engine";

/** Strip auto-approval from a decision, queuing it for manual approval instead. */
export function withoutAutoApprove(decision: PolicyDecision): PolicyDecision {
  if (decision.decision === "allow") {
    return {
      decision: "needs_approval",
      policy: decision.policy,
      mode: "approval_required",
      reason: "auto-approval requires the approvals_policy entitlement",
    };
  }
  return decision;
}

/**
 * Auto-approval (the policy engine) is an enterprise entitlement; without it,
 * anything that would auto-fire is downgraded to manual approval.
 */
export async function gateAutoApprove(
  orgId: string,
  decision: PolicyDecision,
): Promise<PolicyDecision> {
  if (decision.decision !== "allow") return decision;
  return (await orgHasFeature(orgId, FEATURE.approvalsPolicy))
    ? decision
    : withoutAutoApprove(decision);
}
