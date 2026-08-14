import type { ReactNode, TextareaHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type TextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> & {
  /** Doubles as the textarea id, so the label and the error both find it. */
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Sits under the field, right-aligned — a character count, usually. */
  footer?: ReactNode;
};

export function TextArea({
  name,
  label,
  hint,
  error,
  footer,
  className,
  rows = 6,
  ...props
}: TextAreaProps) {
  const describedBy =
    [hint ? `${name}-hint` : null, error ? `${name}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>

      {hint ? (
        <p id={`${name}-hint`} className="text-muted text-xs">
          {hint}
        </p>
      ) : null}

      <div
        className={cn(
          "rounded-lg border bg-surface transition-colors",
          "focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-background",
          error
            ? "border-danger focus-within:ring-danger"
            : "border-border focus-within:ring-accent",
        )}
      >
        <textarea
          id={name}
          name={name}
          rows={rows}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full resize-y bg-transparent px-3 py-2.5 text-sm outline-none",
            "placeholder:text-muted/70",
            className,
          )}
          {...props}
        />
      </div>

      <div className="flex items-start justify-between gap-4">
        {error ? (
          <p id={`${name}-error`} className="text-danger text-xs">
            {error}
          </p>
        ) : (
          <span />
        )}
        {footer ? <span className="text-muted shrink-0 text-xs">{footer}</span> : null}
      </div>
    </div>
  );
}
