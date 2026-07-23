"use client";

import { useEffect } from "react";
import OnboardingUnavailable from "./OnboardingUnavailable";

export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[onboarding] failed to render", error);
  }, [error]);

  return (
    <OnboardingUnavailable
      retryAction={
        <button
          type="button"
          onClick={reset}
          className="entry-button is-primary"
        >
          Retry
        </button>
      }
    />
  );
}
