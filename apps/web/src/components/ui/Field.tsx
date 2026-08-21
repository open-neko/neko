import {
  forwardRef,
  useId,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

const CONTROL_CLASS =
  "w-full rounded-control border-[1.5px] border-border bg-card px-3.5 py-2.5 font-body text-ui-body text-text outline-none transition-[border-color,box-shadow,background-color] placeholder:text-text3 hover:border-text3 focus:border-accent focus:shadow-[0_0_0_3px_rgba(107,92,231,0.10)] disabled:cursor-not-allowed disabled:bg-neutral-soft disabled:opacity-60";

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
};

export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="font-body text-ui-caption font-bold text-text2"
      >
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-ui-caption leading-[var(--leading-compact)] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-ui-caption leading-[var(--leading-compact)] text-text3">{hint}</span>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  ComponentPropsWithoutRef<"input">
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      data-ui-field-control=""
      className={cn(CONTROL_CLASS, className)}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<"textarea">
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-ui-field-control=""
      className={cn(CONTROL_CLASS, "min-h-24 resize-y", className)}
      {...props}
    />
  );
});

export const NativeSelect = forwardRef<
  HTMLSelectElement,
  ComponentPropsWithoutRef<"select">
>(function NativeSelect({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      data-ui-field-control=""
      className={cn(CONTROL_CLASS, "cursor-pointer", className)}
      {...props}
    />
  );
});

type FieldControlProps = Omit<FieldProps, "htmlFor" | "children"> &
  ComponentPropsWithoutRef<"input">;

export function FieldInput({
  label,
  hint,
  error,
  className,
  id,
  ...props
}: FieldControlProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      htmlFor={controlId}
      className={className}
    >
      <Input id={controlId} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}
