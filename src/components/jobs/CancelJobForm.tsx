"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import type { CancellationQuote } from "@/lib/cancellations/tiers";
import { cancelJob } from "@/lib/cancellations/actions";
import { DISPUTE_ROUTES, REASON_MAX_LENGTH } from "@/lib/constants/disputes";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { formatBps, formatPaise } from "@/lib/utils/money";

/**
 * Spec §5's cancellation table, as the one screen a client sees it on.
 *
 * The whole design of this component is the first paragraph of that table: the
 * refund depends on *when*, so the figure has to be on screen before the button
 * is pressed, not in the confirmation that follows it. `quoteCancellation()`
 * works it out server-side and it is rendered here as three lines a person can
 * check — what comes back, what the worker keeps, what the fee is.
 *
 * The quote is a preview and the action says so if it turns out to be stale:
 * `request_job_cancellation()` derives the tier again from its own clock under
 * the job's row lock, and what comes back from it is what is reported. A client
 * who left this page open across a tier boundary is told the tier that actually
 * applied rather than the one they were shown.
 */
export function CancelJobForm({
  jobId,
  quote,
  workerName,
}: {
  jobId: string;
  quote: CancellationQuote;
  workerName: string | null;
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    setReasonError(null);

    const result = await cancelJob({ jobId, reason });

    if (!result.ok) {
      setReasonError(result.fieldErrors?.reason ?? null);
      setError(result.fieldErrors?.reason ? null : result.error);
      setBusy(false);
      return;
    }

    if (result.outcome === "assessed" && result.disputeId) {
      router.push(DISPUTE_ROUTES.case(result.disputeId));
      return;
    }

    router.push(JOB_ROUTES.dashboard);
  }

  // Spec §5's last row. There is no percentage to quote and three other doors
  // are open, so this offers none of its own.
  if (quote.kind === "refused") {
    return (
      <Alert>
        Work has already been delivered on this job, so there is no percentage refund.
        Accept it, ask for the free revision, or open a case.
      </Alert>
    );
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <Button variant="secondary" onClick={() => setOpen(true)} fullWidth={false}>
          Cancel this job
        </Button>
        <p className="text-muted text-xs">
          <Summary quote={quote} workerName={workerName} />
        </p>
      </div>
    );
  }

  return (
    <div className="border-border space-y-4 rounded-xl border p-4">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">
          {quote.kind === "assessed" ? "Ask us to cancel this job" : "Cancel this job"}
        </h3>
        <Breakdown quote={quote} workerName={workerName} />
      </div>

      <TextArea
        name="reason"
        label="Why are you cancelling?"
        hint={
          quote.kind === "assessed"
            ? "More than half the deadline has gone, so a person reads this. It is your statement in the case — say what happened."
            : "Kept on the record, and the worker is told. A line is enough."
        }
        rows={4}
        value={reason}
        maxLength={REASON_MAX_LENGTH}
        error={reasonError ?? undefined}
        onChange={(event) => setReason(event.target.value)}
        footer={`${reason.length}/${REASON_MAX_LENGTH}`}
        disabled={busy}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void submit()} disabled={busy} fullWidth={false}>
          {busy
            ? "Working…"
            : quote.kind === "assessed"
              ? "Ask us to look at it"
              : "Yes, cancel it"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setOpen(false)}
          disabled={busy}
          fullWidth={false}
        >
          Keep the job
        </Button>
      </div>
    </div>
  );
}

/**
 * A quote that has something to say about money.
 *
 * The component above returns early on `refused`, but a narrowing does not
 * travel across a prop, so the two helpers below take the narrower type and the
 * compiler holds the door shut rather than each of them re-checking `kind`.
 */
type ActionableQuote = Exclude<CancellationQuote, { kind: "refused" }>;

/** The one-line version, under the button. */
function Summary({
  quote,
  workerName,
}: {
  quote: ActionableQuote;
  workerName: string | null;
}) {
  if (quote.tier === "pre_assignment") {
    return <>Nobody has been picked yet, so nothing has been charged and there is no fee.</>;
  }

  if (quote.kind === "assessed") {
    return (
      <>
        More than half the deadline has gone, so one of us decides this one — up to{" "}
        {formatBps(quote.clientRefundCapBps)} of the budget comes back to you.
      </>
    );
  }

  if (quote.workerCompensationPaise > 0) {
    return (
      <>
        {formatPaise(quote.clientRefundPaise)} comes back to you;{" "}
        {workerName ?? "the worker"} keeps {formatPaise(quote.workerCompensationPaise)}.
      </>
    );
  }

  return <>{formatPaise(quote.clientRefundPaise)} comes back to you, after the fee.</>;
}

/** The lines a client checks before confirming. Fees, commission and the
 *  worker's share are always separate visible lines — spec §8, and the law. */
function Breakdown({
  quote,
  workerName,
}: {
  quote: ActionableQuote;
  workerName: string | null;
}) {
  if (quote.tier === "pre_assignment") {
    return (
      <p className="text-muted text-sm">
        Nobody was picked for this job, so you were never charged for it and there is no
        cancellation fee. Anyone who opted in is told it is no longer going ahead.
      </p>
    );
  }

  if (quote.kind === "assessed") {
    return (
      <div className="space-y-2">
        <p className="text-muted text-sm">
          {formatBps(quote.elapsedBps)} of the deadline has gone, which is past the point
          where the refund is automatic. This opens a case: the money freezes, {""}
          {workerName ?? "the worker"} gives their side, and one of us decides within five
          days.
        </p>
        <p className="text-muted text-sm">
          The most that can come back to you is {formatBps(quote.clientRefundCapBps)} of
          the budget — {formatPaise(quote.maxClientRefundPaise)}.
        </p>
      </div>
    );
  }

  return (
    <dl className="border-border divide-border divide-y rounded-lg border text-sm">
      <Row label="Back to you" value={formatPaise(quote.clientRefundPaise)} strong />
      {quote.workerCompensationPaise > 0 ? (
        <Row
          label={`${workerName ?? "The worker"} keeps`}
          value={formatPaise(quote.workerCompensationPaise)}
        />
      ) : null}
      <Row label="Cancellation fee" value={formatPaise(quote.feePaise)} />
    </dl>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className={strong ? "font-medium tabular-nums" : "tabular-nums"}>{value}</dd>
    </div>
  );
}
