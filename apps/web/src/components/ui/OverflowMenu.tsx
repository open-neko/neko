"use client";

import { MoreHorizontal } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type OverflowMenuProps = {
  label?: string;
  align?: "start" | "end";
  children: ReactNode;
  className?: string;
};

export function OverflowMenu({
  label = "More actions",
  align = "end",
  children,
  className,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutside(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", className)}>
      <IconButton
        label={label}
        size="icon-sm"
        variant="ghost"
        data-ui-menu-trigger=""
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal aria-hidden="true" />
      </IconButton>
      {open ? (
        <div
          id={menuId}
          role="menu"
          className={cn(
            "absolute top-[calc(100%+6px)] z-[80] grid min-w-44 gap-1 rounded-inner border border-border bg-card p-1.5 shadow-lift",
            align === "end" ? "right-0" : "left-0",
          )}
          onClickCapture={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

type MenuItemProps = {
  danger?: boolean;
} & ComponentPropsWithoutRef<"button">;

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(
  function MenuItem({ danger = false, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        data-ui-menu-item=""
        className={cn(
          "flex min-h-9 w-full items-center gap-2 rounded-[8px] border-0 bg-transparent px-3 py-2 text-left font-body text-ui-body-sm font-semibold text-text2 transition-colors hover:bg-neutral-soft hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
          danger && "text-danger hover:bg-danger-soft hover:text-danger",
          className,
        )}
        {...props}
      />
    );
  },
);
