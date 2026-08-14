"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { APPROVAL_SLA_HOURS } from "@/lib/constants/workers";
import { submitWorkerApplication } from "@/lib/workers/actions";

/**
 * The one-way door out of 'draft' (spec §6). The button is disabled until every
 * category has its minimum, but the count that decides the outcome is the one
 * `submit_worker_application()` takes for itself — this only spares the worker a
 * round trip to be told what they can already see.
 */
export function SubmitApplication({
  ready,
  resubmission,
}: {
  ready: boolean;
  /** Their one resubmission after a rejection, which reads differently. */
  resubmission: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);

    const result = await submitWorkerApplication();

    // On success the page revalidates into the "in review" state, so there is
    // nothing to reset — this component is about to be replaced.
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <p className="text-muted min-w-0 flex-1 text-sm">
          {ready
            ? `We review samples within ${APPROVAL_SLA_HOURS} hours. Your samples are locked while we do.`
            : "Add the minimum samples in every category and this unlocks."}
        </p>

        <Button onClick={() => void submit()} disabled={!ready || busy}>
          {busy ? "Sending…" : resubmission ? "Resubmit for review" : "Submit for review"}
        </Button>
      </div>
    </div>
  );
}
