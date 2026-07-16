"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Thumb-first navigation for small screens. Replaces the top-strip section nav
// on phones: five primary destinations with Ask raised as a center action, a
// live badge on Actions, and a "More" sheet that folds in the secondary
// surfaces. Hidden on >720px (the top bar keeps its nav there) and on the
// auth/onboarding routes, which have no app chrome.
//
// One nav model, ergonomically reshaped per size — the phone form of the same
// rail the wider layouts use.

const SECONDARY = [
  { href: "/business-profile", label: "Business Profile", desc: "How your business runs" },
  { href: "/memory", label: "Memory", desc: "Pinned facts & learned rules" },
  { href: "/skills", label: "Skills", desc: "What OpenNeko can do" },
  { href: "/integrations", label: "Integrations", desc: "Slack, Gmail, Stripe…" },
  { href: "/admin", label: "Admin", desc: "Users, model, data sources" },
];

function isActive(pathname: string, base: string) {
  if (base === "/") return pathname === "/";
  return pathname === base || pathname.startsWith(`${base}/`);
}

export default function CommandDock() {
  const pathname = usePathname() ?? "/";
  const [pending, setPending] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // Pending-approvals badge — same poll the section nav uses, so the count
  // stays live whether you reach Actions from the top bar or the dock.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/approvals?countOnly=true", { cache: "no-store" });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { count?: number };
        setPending(data.count ?? 0);
      } catch {
        // best-effort; ignore network blips
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Close the More sheet on outside taps. (Navigation closes it via the
  // onClick handlers below, so there's no setState-in-effect on pathname.)
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [moreOpen]);

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/signin";
    }
  }

  // No app chrome on the auth / onboarding flows.
  if (pathname.startsWith("/signin") || pathname.startsWith("/onboarding")) {
    return null;
  }

  const moreActive = SECONDARY.some((s) => isActive(pathname, s.href));

  return (
    <div className="cdock-wrap" ref={moreRef}>
      {moreOpen && (
        <div className="cdock-sheet" role="menu" aria-label="More destinations">
          {SECONDARY.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              role="menuitem"
              onClick={() => setMoreOpen(false)}
              className={`cdock-sheet-row${isActive(pathname, s.href) ? " is-active" : ""}`}
            >
              <span className="cdock-sheet-label">{s.label}</span>
              <span className="cdock-sheet-desc">{s.desc}</span>
            </Link>
          ))}
          <button type="button" className="cdock-sheet-out" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      )}

      <nav className="cdock" aria-label="Primary">
        <Link
          href="/"
          onClick={() => setMoreOpen(false)}
          className={`cdock-item${isActive(pathname, "/") ? " is-active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 11.5 12 4l8 7.5" />
            <path d="M6 10v9h12v-9" strokeLinecap="round" />
          </svg>
          <span className="cdock-lbl">Briefing</span>
        </Link>

        <Link
          href="/workflows"
          onClick={() => setMoreOpen(false)}
          className={`cdock-item${isActive(pathname, "/workflows") ? " is-active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <rect x="3.5" y="6" width="17" height="11" rx="3" />
            <path d="M8 20l3-3" strokeLinecap="round" />
          </svg>
          <span className="cdock-lbl">Workflows</span>
        </Link>

        <Link href="/work" onClick={() => setMoreOpen(false)} className="cdock-center" aria-label="Ask">
          <span className={`cdock-fab${isActive(pathname, "/work") ? " is-active" : ""}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path
                d="M12 3a9 9 0 0 1 0 18 9.3 9.3 0 0 1-3.8-.8L3 21l1-4.4A9 9 0 0 1 12 3Z"
                strokeLinejoin="round"
              />
              <path d="M8.5 11h7M8.5 14h4" strokeLinecap="round" />
            </svg>
          </span>
          <span className="cdock-lbl cdock-lbl-center">Ask</span>
        </Link>

        <Link
          href="/actions"
          onClick={() => setMoreOpen(false)}
          className={`cdock-item${isActive(pathname, "/actions") ? " is-active" : ""}`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M5 12.5l4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="cdock-lbl">Actions</span>
          {pending > 0 && (
            <span className="cdock-badge font-mono" aria-label={`${pending} pending`}>
              {pending}
            </span>
          )}
        </Link>

        <button
          type="button"
          className={`cdock-item${moreActive || moreOpen ? " is-active" : ""}`}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="6" cy="12" r="1.4" />
            <circle cx="12" cy="12" r="1.4" />
            <circle cx="18" cy="12" r="1.4" />
          </svg>
          <span className="cdock-lbl">More</span>
        </button>
      </nav>
    </div>
  );
}
