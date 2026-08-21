import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/cn";

export function Tabs({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-control border border-border bg-neutral-soft p-1",
        className,
      )}
      {...props}
    />
  );
}

type TabProps = {
  selected?: boolean;
} & ComponentPropsWithoutRef<"button">;

export function Tab({ selected = false, className, ...props }: TabProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      data-ui-tab=""
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center justify-center rounded-[8px] border border-transparent px-3 py-1.5 font-body text-ui-body-sm font-semibold text-text2 transition-[background-color,color,border-color,box-shadow] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        selected && "border-border bg-card text-text shadow-soft",
        className,
      )}
      {...props}
    />
  );
}

export function SegmentedControl({
  className,
  ...props
}: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-neutral p-1",
        className,
      )}
      {...props}
    />
  );
}

type SegmentProps = {
  selected?: boolean;
} & ComponentPropsWithoutRef<"button">;

export function Segment({
  selected = false,
  className,
  ...props
}: SegmentProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      data-ui-segment=""
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center justify-center rounded-full border-0 bg-transparent px-3 py-1.5 font-body text-ui-body-sm font-semibold text-text2 transition-[background-color,color,box-shadow] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        selected && "bg-card text-text shadow-soft",
        className,
      )}
      {...props}
    />
  );
}
