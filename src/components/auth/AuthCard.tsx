import type { ReactNode } from "react";

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="border-border bg-surface w-full rounded-2xl border p-6 sm:p-8">
      <div className="mb-6 space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted text-sm">{description}</p> : null}
      </div>

      {children}

      {footer ? (
        <div className="border-border text-muted mt-6 border-t pt-4 text-sm">{footer}</div>
      ) : null}
    </div>
  );
}
