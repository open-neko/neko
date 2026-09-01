"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Ellipsis,
  LogOut,
  UserRound,
  X,
} from "lucide-react";
import DensityToggle from "@/components/DensityToggle";
import {
  PRIMARY_NAV,
  SECONDARY_NAV,
  hideAppChrome,
  isActive,
  useApprovalsCount,
  type NavDestination,
} from "@/lib/nav";

type OpenSheet = "more" | null;

const dockDestination = (href: string) => {
  const destination = PRIMARY_NAV.find((item) => item.href === href);
  if (!destination) throw new Error(`Missing dock destination: ${href}`);
  return destination;
};

const DASHBOARD = dockDestination("/");
const WORKFLOWS = dockDestination("/workflows");
const ASK = dockDestination("/work");
const ACTIONS = dockDestination("/actions");

function DockLink({
  item,
  pathname,
  pending = 0,
  onNavigate,
}: {
  item: NavDestination;
  pathname: string;
  pending?: number;
  onNavigate: () => void;
}) {
  const active = isActive(pathname, item.href);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={`cdock-item${active ? " is-active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      <Icon aria-hidden="true" strokeWidth={1.9} />
      <span className="cdock-lbl">{item.shortLabel}</span>
      {item.href === "/actions" && pending > 0 ? (
        <span className="cdock-badge font-mono" aria-label={`${pending} pending`}>
          {pending > 99 ? "99+" : pending}
        </span>
      ) : null}
    </Link>
  );
}

export default function CommandDock() {
  const pathname = usePathname() ?? "/";
  const hidden = hideAppChrome(pathname);
  const pending = useApprovalsCount(!hidden);
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const [session, setSession] = useState<{
    resolved: boolean;
    signedIn: boolean;
    role: "admin" | "member" | null;
  }>({ resolved: false, signedIn: false, role: null });
  const sheetRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLAnchorElement | HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!openSheet) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => sheetRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(".confirm-modal-root")
      ) {
        setOpenSheet(null);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, [openSheet]);

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/session", {
          cache: "no-store",
        });
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as {
          user: { id: string } | null;
          role: "admin" | "member" | null;
        };
        setSession({
          resolved: true,
          signedIn: Boolean(data.user),
          role: data.role,
        });
      } catch {
        // Keep member-only controls absent until identity is known.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hidden]);

  async function handleSignOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/signin";
    }
  }

  function closeSheet() {
    setOpenSheet(null);
  }

  if (hidden) return null;

  const secondaryNav = SECONDARY_NAV.filter(
    (item) =>
      item.href !== "/admin" ||
      (session.resolved && session.role !== "member"),
  );
  const moreActive = secondaryNav.some((item) => isActive(pathname, item.href));
  return (
    <div className="cdock-wrap">
      {openSheet ? (
        <>
          <button data-ui-bespoke-reason="phone command dock"
            type="button"
            className="cdock-scrim"
            aria-label="Close navigation sheet"
            onClick={closeSheet}
          />
          <section
            ref={sheetRef}
            id={`cdock-${openSheet}-sheet`}
            className={`cdock-sheet is-${openSheet}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`cdock-${openSheet}-title`}
            tabIndex={-1}
          >
            <div className="cdock-sheet-grab" aria-hidden="true" />
            <div className="cdock-sheet-head">
              <div>
                <h2 id={`cdock-${openSheet}-title`}>
                  More
                </h2>
                <p>Knowledge, connections, and workspace settings.</p>
              </div>
              <button data-ui-bespoke-reason="phone command dock"
                type="button"
                className="cdock-sheet-close"
                aria-label="Close"
                onClick={closeSheet}
              >
                <X aria-hidden="true" strokeWidth={2} />
              </button>
            </div>

            <>
                <nav className="cdock-sheet-list" aria-label="More destinations">
                  {secondaryNav.map((item) => {
                    const active = isActive(pathname, item.href);
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={closeSheet}
                        aria-current={active ? "page" : undefined}
                        className={`cdock-sheet-row${active ? " is-active" : ""}`}
                      >
                        <span className="cdock-sheet-icon">
                          <Icon aria-hidden="true" strokeWidth={1.9} />
                        </span>
                        <span className="cdock-sheet-copy">
                          <span className="cdock-sheet-label">{item.label}</span>
                          <span className="cdock-sheet-desc">{item.description}</span>
                        </span>
                        <ChevronRight className="cdock-sheet-chevron" aria-hidden="true" />
                      </Link>
                    );
                  })}
                </nav>
                {session.signedIn ? (
                  <Link
                    href="/onboarding"
                    onClick={closeSheet}
                    className="cdock-persona-link"
                  >
                    <UserRound aria-hidden="true" strokeWidth={1.9} />
                    <span>
                      <strong>Personal setup</strong>
                      <small>Role and priorities</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </Link>
                ) : null}
                <div className="cdock-sheet-settings">
                  <span>Layout density</span>
                  <DensityToggle />
                </div>
                {session.signedIn ? (
                  <button data-ui-bespoke-reason="phone command dock" type="button" className="cdock-sheet-out" onClick={handleSignOut}>
                    <LogOut aria-hidden="true" strokeWidth={2} />
                    <span>Sign out</span>
                  </button>
                ) : null}
            </>
          </section>
        </>
      ) : null}

      <nav className="cdock" aria-label="Primary navigation">
        <DockLink item={DASHBOARD} pathname={pathname} onNavigate={closeSheet} />
        <DockLink item={WORKFLOWS} pathname={pathname} onNavigate={closeSheet} />

        <DockLink item={ASK} pathname={pathname} onNavigate={closeSheet} />

        <DockLink
          item={ACTIONS}
          pathname={pathname}
          pending={pending}
          onNavigate={closeSheet}
        />

        <button data-ui-bespoke-reason="phone command dock"
          ref={(node) => {
            if (openSheet === "more") triggerRef.current = node;
          }}
          type="button"
          className={`cdock-item${moreActive || openSheet === "more" ? " is-active" : ""}`}
          aria-expanded={openSheet === "more"}
          aria-controls="cdock-more-sheet"
          onClick={(event) => {
            triggerRef.current = event.currentTarget;
            setOpenSheet((current) => (current === "more" ? null : "more"));
          }}
        >
          <Ellipsis aria-hidden="true" strokeWidth={2.2} />
          <span className="cdock-lbl">More</span>
        </button>
      </nav>
    </div>
  );
}
