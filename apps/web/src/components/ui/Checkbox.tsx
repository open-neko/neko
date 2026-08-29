import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

export type CheckboxProps = Omit<
  ComponentPropsWithoutRef<"input">,
  "className" | "type"
> & {
  label: ReactNode;
  className?: string;
  inputClassName?: string;
  labelClassName?: string;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(
    {
      label,
      className,
      inputClassName,
      labelClassName,
      disabled,
      ...props
    },
    ref,
  ) {
    return (
      <label
        data-ui-checkbox=""
        className={cn(
          "inline-flex min-w-0 items-start gap-2 font-body text-ui-body-sm leading-[var(--leading-compact)] text-text2",
          disabled
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer",
          className,
        )}
      >
        <input
          ref={ref}
          type="checkbox"
          disabled={disabled}
          data-ui-checkbox-control=""
          className={cn(
            "mt-0.5 size-4 shrink-0 cursor-pointer rounded-[4px] accent-accent",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            "disabled:cursor-not-allowed",
            inputClassName,
          )}
          {...props}
        />
        <span className={cn("min-w-0", labelClassName)}>{label}</span>
      </label>
    );
  },
);
