"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Ellipsis, LogOut, X } from "lucide-react";
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

  const moreActive = SECONDARY_NAV.some((item) => isActive(pathname, item.href));
  const askActive = isActive(pathname, ASK.href);
  const AskIcon = ASK.icon;

  return (
    <div className="cdock-wrap">
      {openSheet ? (
        <>
          <button
            type="button"
            className="cdock-scrim"
            aria-label="Close navigation sheet"
            onClick={closeSheet}
          />
          <section
            ref={sheetRef}
            id="cdock-more-sheet"
            className="cdock-sheet is-more"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cdock-more-title"
            tabIndex={-1}
          >
            <div className="cdock-sheet-grab" aria-hidden="true" />
            <div className="cdock-sheet-head">
              <div>
                <h2 id="cdock-more-title">More</h2>
                <p>Knowledge, connections, and workspace settings.</p>
              </div>
              <button
                type="button"
                className="cdock-sheet-close"
                aria-label="Close"
                onClick={closeSheet}
              >
                <X aria-hidden="true" strokeWidth={2} />
              </button>
            </div>

            <nav className="cdock-sheet-list" aria-label="More destinations">
              {SECONDARY_NAV.map((item) => {
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
            <div className="cdock-sheet-settings">
              <span>Layout density</span>
              <DensityToggle />
            </div>
            <button type="button" className="cdock-sheet-out" onClick={handleSignOut}>
              <LogOut aria-hidden="true" strokeWidth={2} />
              <span>Sign out</span>
            </button>
          </section>
        </>
      ) : null}

      <nav className="cdock" aria-label="Primary navigation">
        <DockLink item={DASHBOARD} pathname={pathname} onNavigate={closeSheet} />
        <DockLink item={WORKFLOWS} pathname={pathname} onNavigate={closeSheet} />

        <Link
          href={ASK.href}
          onClick={closeSheet}
          className={`cdock-item cdock-ask${askActive ? " is-active" : ""}`}
          aria-label="Ask OpenNeko"
          aria-current={askActive ? "page" : undefined}
        >
          <AskIcon aria-hidden="true" strokeWidth={1.9} />
          <span className="cdock-lbl">Ask</span>
        </Link>

        <DockLink
          item={ACTIONS}
          pathname={pathname}
          pending={pending}
          onNavigate={closeSheet}
        />

        <button
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
