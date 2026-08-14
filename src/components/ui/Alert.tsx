import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

export type AlertTone = "error" | "info" | "success";

const TONES: Record<AlertTone, string> = {
  error: "border-danger/40 bg-danger/8 text-danger",
  info: "border-border bg-surface-muted text-foreground",
  success: "border-success/40 bg-success/8 text-success",
};

export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      // Errors interrupt; a notice can wait for the next natural pause.
      role={tone === "error" ? "alert" : "status"}
      className={cn("rounded-lg border px-3 py-2.5 text-sm", TONES[tone], className)}
    >
      {children}
    </p>
  );
}
