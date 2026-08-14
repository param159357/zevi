"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { selectWorker } from "@/lib/matching/actions";

/**
 * Picking a worker (spec §5). Two taps, not one.
 *
 * The confirm step is not politeness: assignment takes a lock, closes the job,
 * and turns every other opt-in into a rejection. There is no undo — cancelling
 * afterwards costs the client ₹15 and the worker their slot — and the button
 * sits in a list of rows that look alike. One misplaced click should not be
 * able to do that.
 *
 * On success the action redirects, so this component only ever handles failure.
 */
export function PickWorker({
  jobId,
  optInId,
  workerName,
}: {
  jobId: string;
  optInId: string;
  workerName: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick() {
    setBusy(true);
    setError(null);

    const result = await selectWorker({ jobId, optInId });

    setError(result.error);
    setBusy(false);
    setConfirming(false);
  }

  if (!confirming) {
    return (
      <div className="space-y-2">
        {error ? (
          <p className="text-danger text-xs" role="alert">
            {error}
          </p>
        ) : null}

        <Button variant="secondary" onClick={() => setConfirming(true)}>
          Pick {workerName}
        </Button>
      </div>
    );
  }

  return (
    <div className="border-border bg-surface-muted space-y-3 rounded-lg border p-3">
      <p className="text-sm">
        Assign this job to {workerName}? Everyone else who opted in is told they
        weren&apos;t picked, and the job closes to new opt-ins.
      </p>

      {error ? (
        <p className="text-danger text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void pick()} disabled={busy} aria-busy={busy}>
          {busy ? "Assigning…" : `Yes, pick ${workerName}`}
        </Button>
        <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
