"use client";

import { useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@/components/ui/Button";

export type ConfirmDialogOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

function cleanup() {
  const root = activeRoot;
  const container = activeContainer;
  activeRoot = null;
  activeContainer = null;
  if (root) {
    queueMicrotask(() => {
      try {
        root.unmount();
      } catch {
        // already unmounted
      }
      if (container?.parentElement) {
        container.parentElement.removeChild(container);
      }
    });
  }
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve(false);
  }
  cleanup();
  return new Promise<boolean>((resolve) => {
    const container = document.createElement("div");
    container.className = "confirm-modal-root";
    document.body.appendChild(container);
    activeContainer = container;
    const root = createRoot(container);
    activeRoot = root;

    const onChoice = (choice: boolean) => {
      cleanup();
      resolve(choice);
    };

    root.render(<ConfirmDialog options={options} onChoice={onChoice} />);
  });
}

function ConfirmDialog({
  options,
  onChoice,
}: {
  options: ConfirmDialogOptions;
  onChoice: (choice: boolean) => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onChoice(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        onChoice(true);
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onChoice]);

  const onBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onChoice(false);
  };

  return (
    <div
      className="fixed inset-0 z-[1000] bg-[var(--backdrop)] backdrop-blur-[4px] flex items-center justify-center p-4 overscroll-contain animate-[modal-fade_0.15s_ease-out]"
      onClick={onBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
    >
      <div className="w-full max-w-[420px] bg-card border border-border rounded-card px-[22px] pt-[22px] pb-[18px] shadow-lift animate-[modal-rise_0.18s_cubic-bezier(0.16,1,0.3,1)]">
        <h2
          id="confirm-modal-title"
          className="font-display text-base font-bold leading-tight text-text m-0"
        >
          {options.title}
        </h2>
        {options.description ? (
          <p className="mt-2 text-ui-body leading-[1.55] text-text2 whitespace-pre-line">
            {options.description}
          </p>
        ) : null}
        <div className="mt-[18px] flex justify-end gap-2">
          <Button
            ref={cancelRef}
            size="sm"
            onClick={() => onChoice(false)}
          >
            {options.cancelLabel ?? "Cancel"}
          </Button>
          <Button
            variant={options.destructive ? "danger" : "primary"}
            size="sm"
            onClick={() => onChoice(true)}
          >
            {options.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </div>
    </div>
  );
}
