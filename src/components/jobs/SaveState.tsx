"use client";

import { useEffect, useState } from "react";

import { formatTime } from "@/lib/utils/format";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Spec §5: drafts are saved automatically. Which only helps if the client can
 * tell that it happened — so this says which of the four states it is in and
 * never claims "saved" while a write is still out.
 */
export function SaveState({
  status,
  savedAt,
}: {
  status: SaveStatus;
  savedAt: string | null;
}) {
  // Rendered on the client only: a timestamp formatted on the server is a
  // hydration mismatch waiting to happen.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (status === "saving") {
    return <p className="text-muted text-xs">Saving…</p>;
  }

  if (status === "error") {
    return (
      <p className="text-danger text-xs" role="status">
        Not saved — your changes are still on this screen.
      </p>
    );
  }

  if (savedAt && mounted) {
    return (
      <p className="text-muted text-xs" role="status">
        Draft saved at {formatTime(savedAt)}
      </p>
    );
  }

  return <p className="text-muted text-xs">Saved automatically as you type</p>;
}
