"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { REVISION_REASON_MAX_LENGTH } from "@/lib/constants/deliveries";
import { DISPUTE_ROUTES } from "@/lib/constants/disputes";
import { acceptDelivery, requestRevision } from "@/lib/deliveries/actions";

/**
 * Spec §5's three endings — all three of them, now that the third exists.
 *
 * Accept releases the escrow, a revision is the one free one, and a dispute
 * freezes the money and puts it in front of a person. They are deliberately not
 * three equal buttons: accepting is what should happen, the revision is the
 * cheap way to fix most of what does not, and a case is the last door. The
 * ordering and the weight say so.
 *
 * Both of the actions here confirm. Accepting is irreversible and pays someone;
 * asking for changes spends the only free revision the job has. Neither is a
 * thing to do by brushing a button on a phone. The dispute is a link rather than
 * an action, because it opens a screen that asks for 500 characters — which is
 * its own confirmation, and a better one.
 */
export function ReviewActions({
  deliveryId,
  jobId,
  workerName,
  freeRevisionsLeft,
}: {
  deliveryId: string;
  jobId: string;
  workerName: string;
  freeRevisionsLeft: number;
}) {
  const [mode, setMode] = useState<"idle" | "accepting" | "revising">("idle");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);

    const result = await acceptDelivery(deliveryId);

    if (!result.ok) {
      setError(result.error);
      setBusy(false);
      setMode("idle");
      return;
    }

    // On success the action revalidates and this panel is replaced by the
    // completed state, so `busy` is deliberately left true.
  }

  async function revise() {
    setBusy(true);
    setError(null);
    setReasonError(null);

    const result = await requestRevision({ deliveryId, reason });

    if (!result.ok) {
      setReasonError(result.fieldErrors?.reason ?? null);
      setError(result.fieldErrors?.reason ? null : result.error);
      setBusy(false);
      return;
    }
  }

  if (mode === "accepting") {
    return (
      <div className="border-border space-y-3 rounded-xl border p-4">
        <p className="text-sm">
          Accepting releases the money to {workerName} and unlocks the clean files for
          you. It can&apos;t be undone.
        </p>
        {error ? <Alert tone="error">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void accept()} disabled={busy} fullWidth={false}>
            {busy ? "Accepting…" : "Yes, accept it"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setMode("idle")}
            disabled={busy}
            fullWidth={false}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  if (mode === "revising") {
    return (
      <div className="border-border space-y-3 rounded-xl border p-4">
        <TextArea
          name="reason"
          label="What needs changing?"
          hint={`This is the one free revision on this job, and it's all ${workerName} gets to work from — be specific.`}
          rows={5}
          value={reason}
          maxLength={REVISION_REASON_MAX_LENGTH}
          error={reasonError ?? undefined}
          onChange={(event) => setReason(event.target.value)}
          footer={`${reason.length}/${REVISION_REASON_MAX_LENGTH}`}
          disabled={busy}
        />

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void revise()} disabled={busy} fullWidth={false}>
            {busy ? "Sending…" : "Send the revision"}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setMode("idle")}
            disabled={busy}
            fullWidth={false}
          >
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setMode("accepting")} fullWidth={false}>
          Accept the work
        </Button>

        {freeRevisionsLeft > 0 ? (
          <Button variant="secondary" onClick={() => setMode("revising")} fullWidth={false}>
            Ask for a revision
          </Button>
        ) : null}

        <Link href={DISPUTE_ROUTES.raise(jobId)}>
          <Button variant="ghost" fullWidth={false}>
            Open a case
          </Button>
        </Link>
      </div>

      <p className="text-muted text-xs">
        {freeRevisionsLeft > 0
          ? "One revision is free. If the work isn't close enough for that to help, open a case and one of us will decide it."
          : "You've used the free revision on this job. If the work still isn't right, open a case rather than accepting it."}
      </p>
    </div>
  );
}
