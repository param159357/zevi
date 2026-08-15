"use client";

import { useEffect, useRef, useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { refreshWorkerKyc } from "@/lib/kyc/actions";

/**
 * "Has the bank answered yet?"
 *
 * The penny drop is asynchronous — Razorpay returns `created` and the
 * beneficiary bank confirms the name seconds to minutes later — so something has
 * to ask again.
 *
 * Once on mount, then only when the worker asks. The mount check is what makes
 * "come back later and it will have sorted itself out" true; a timer would mean
 * a page left open in a tab billing Razorpay every few seconds for as long as it
 * is open, which is a cost with no owner. The settle path is idempotent, so a
 * double-invoked effect in development costs one wasted read.
 *
 * This does not run during the server render, deliberately: settling calls
 * `revalidatePath`, and Next refuses that while a page is rendering.
 */
export function KycRefresh() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checkedOnMount = useRef(false);

  async function check() {
    setBusy(true);
    setError(null);

    const result = await refreshWorkerKyc();

    // A settled result revalidates the page and this panel is replaced. Anything
    // else is still in flight, or is the reason it is not.
    if (!result.ok) setError(result.error);
    setBusy(false);
  }

  useEffect(() => {
    if (checkedOnMount.current) return;
    checkedOnMount.current = true;

    // Deliberately once, for the life of this mount — the ref above is what
    // makes that true rather than the empty dependency list.
    void check();
  }, []);

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Button variant="secondary" onClick={() => void check()} disabled={busy}>
        {busy ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
