import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type EmptyStateProps = {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

export function EmptyState({
  title,
  body,
  action,
  icon,
  className,
}: EmptyStateProps) {
  return (
    <section
      data-ui-empty-state=""
      className={cn(
        "mx-auto grid max-w-[520px] justify-items-center gap-3 py-14 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          data-ui-empty-state-icon=""
          className="grid size-11 place-items-center rounded-inner bg-neutral text-text2 [&_svg]:size-5"
        >
          {icon}
        </span>
      ) : null}
      <div data-ui-empty-state-copy="" className="grid gap-1.5">
        <h2 data-ui-empty-state-title="" className="text-ui-section">
          {title}
        </h2>
        {body ? (
          <div
            data-ui-empty-state-body=""
            className="text-ui-body-sm leading-[var(--leading-body)] text-text2"
          >
            {body}
          </div>
        ) : null}
      </div>
      {action ? (
        <div data-ui-empty-state-action="" className="pt-1">
          {action}
        </div>
      ) : null}
    </section>
  );
}
