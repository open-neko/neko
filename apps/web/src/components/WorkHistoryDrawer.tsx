"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import AskHistoryPanel from "@/components/AskHistoryPanel";

export default function WorkHistoryDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(".confirm-modal-root")
      ) {
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="work-history-layer">
      <button data-ui-bespoke-reason="ask history drawer"
        type="button"
        className="work-history-scrim"
        aria-label="Close thread history"
        onClick={onClose}
      />
      <aside
        className="work-history-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-history-title"
      >
        <header className="work-history-drawer-head">
          <div>
            <span>OpenNeko / Work</span>
            <h2 id="work-history-title">Past work</h2>
            <p>Resume one of your threads.</p>
          </div>
          <button data-ui-bespoke-reason="ask history drawer"
            ref={closeRef}
            type="button"
            className="work-history-close"
            aria-label="Close thread history"
            onClick={onClose}
          >
            <X aria-hidden="true" strokeWidth={2} />
          </button>
        </header>
        <AskHistoryPanel
          className="work-history-panel"
          onNavigate={onClose}
        />
      </aside>
    </div>
  );
}
