import { describe, expect, it } from "vitest";
import { profileBuildFailureMessage } from "@/lib/onboarding-failure";

describe("profileBuildFailureMessage", () => {
  it("classifies a Hermes budget timeout without claiming the runtime vanished", () => {
    const message = profileBuildFailureMessage(
      "hermes turn exceeded its 360s budget and was terminated",
    );
    expect(message).toContain("time limit");
    expect(message).not.toContain("agent became unavailable");
  });

  it("keeps serving-status recovery for an actual sandbox contract failure", () => {
    expect(
      profileBuildFailureMessage(
        "agent sandbox exited 1: builtin-skills not found",
      ),
    ).toContain("agent became unavailable");
  });

  it("classifies missing local Hermes configuration as a worker handoff failure", () => {
    const message = profileBuildFailureMessage(
      "Internal error: No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration.",
    );
    expect(message).toContain("worker could not load the saved model configuration");
    expect(message).not.toContain("model provider rejected");
  });

  it("does not expose an unknown persisted error to the browser", () => {
    const internal = "unexpected /private/path containing sensitive context";
    expect(profileBuildFailureMessage(internal)).not.toContain(internal);
  });
});
