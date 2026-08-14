"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { withdrawOptIn } from "@/lib/matching/actions";

/**
 * Frees one of the five slots. Two taps rather than one: an opt-in is a
 * promise a client may already be reading, and the list this sits in is a list
 * of rows that look alike.
 */
export function WithdrawOptIn({ optInId }: { optInId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function withdraw() {
    setBusy(true);
    setError(null);

    const result = await withdrawOptIn(optInId);

    // On success the action revalidates and this row leaves the list.
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <p className="text-danger shrink-0 text-xs" role="alert">
        {error}
      </p>
    );
  }

  if (!confirming) {
    return (
      <Button
        variant="ghost"
        onClick={() => setConfirming(true)}
        className="shrink-0 px-2 py-1 text-xs"
      >
        Withdraw
      </Button>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        onClick={() => setConfirming(false)}
        disabled={busy}
        className="px-2 py-1 text-xs"
      >
        Keep
      </Button>
      <Button
        variant="secondary"
        onClick={() => void withdraw()}
        disabled={busy}
        className="text-danger px-2 py-1 text-xs"
      >
        {busy ? "Withdrawing…" : "Confirm"}
      </Button>
    </span>
  );
}
