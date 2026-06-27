import type { ReactNode } from "react";

type OnboardingUnavailableProps = {
  retryAction?: ReactNode;
};

export default function OnboardingUnavailable({
  retryAction,
}: OnboardingUnavailableProps) {
  return (
    <main className="min-h-screen bg-bg px-5 py-10 text-text">
      <section className="mx-auto mt-[12vh] w-full max-w-[520px] rounded-lg border border-border bg-card p-6 shadow-soft">
        <p className="m-0 text-[11px] font-bold uppercase tracking-[0.12em] text-text3">
          Onboarding
        </p>
        <h1 className="mt-3 font-display text-[28px] font-extrabold leading-tight text-text">
          Onboarding is unavailable.
        </h1>
        <p className="mt-3 text-[14px] leading-6 text-text2">
          OpenNeko could not read the workspace setup state. Check the database
          settings, then retry.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <a
            href="/admin/settings"
            className="inline-flex h-10 items-center rounded-control border border-text bg-text px-4 text-[13px] font-semibold text-bg no-underline"
          >
            Admin settings
          </a>
          {retryAction ?? (
            <a
              href="/onboarding"
              className="inline-flex h-10 items-center rounded-control border border-border bg-card px-4 text-[13px] font-semibold text-text no-underline hover:border-text3"
            >
              Retry
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
