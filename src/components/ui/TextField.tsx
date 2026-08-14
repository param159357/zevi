import type { InputHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  /** Doubles as the input id, so the label and the error both find it. */
  name: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Fixed text inside the field — the `+91` on a mobile number. */
  prefix?: string;
};

export function TextField({
  name,
  label,
  hint,
  error,
  prefix,
  className,
  ...props
}: TextFieldProps) {
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
          "flex items-center rounded-lg border bg-surface transition-colors",
          "focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-background",
          error
            ? "border-danger focus-within:ring-danger"
            : "border-border focus-within:ring-accent",
        )}
      >
        {prefix ? (
          <span className="text-muted pl-3 text-sm select-none">{prefix}</span>
        ) : null}

        <input
          id={name}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cn(
            "w-full bg-transparent px-3 py-2.5 text-sm outline-none",
            "placeholder:text-muted/70",
            prefix && "pl-2",
            className,
          )}
          {...props}
        />
      </div>

      {error ? (
        <p id={`${name}-error`} className="text-danger text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
