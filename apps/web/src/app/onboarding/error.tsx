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
          className="inline-flex h-10 cursor-pointer items-center rounded-control border border-border bg-card px-4 font-body text-[13px] font-semibold text-text hover:border-text3"
        >
          Retry
        </button>
      }
    />
  );
}
