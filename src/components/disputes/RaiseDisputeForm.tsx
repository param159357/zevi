"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { TextField } from "@/components/ui/TextField";
import {
  DECISION_DAYS,
  DISPUTE_ROUTES,
  FIRST_RESPONSE_HOURS,
  REASON_MAX_LENGTH,
  RESPONSE_HOURS,
  STATEMENT_MAX_LENGTH,
} from "@/lib/constants/disputes";
import { raiseDispute } from "@/lib/disputes/actions";

/**
 * Spec §11's opening move, for whichever side is filing it.
 *
 * Two fields, because the case has two readers: the summary is what a reviewer
 * sees in a queue of forty, and the statement is what they read once they open
 * it. Asking for both is the difference between a queue that can be triaged and
 * a queue of 500-character paragraphs.
 *
 * The three deadlines are stated before the button, not after it — spec §11 says
 * "48h to first response, 5 days to decision — stated on screen", and someone
 * deciding whether to escalate deserves to know what they are starting.
 *
 * It confirms. Raising a dispute freezes the money on both sides, stops the
 * auto-accept clock, and shows up on both parties' records; it is not a thing to
 * do by brushing a button on a phone.
 */
export function RaiseDisputeForm({
  jobId,
  viewerRole,
  otherPartyName,
}: {
  jobId: string;
  viewerRole: "client" | "worker";
  otherPartyName: string;
}) {
  const router = useRouter();

  const [reason, setReason] = useState("");
  const [statement, setStatement] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit() {
    setBusy(true);
    setError(null);
    setFieldErrors({});

    const result = await raiseDispute({ jobId, reason, statement });

    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setError(result.fieldErrors ? null : result.error);
      setBusy(false);
      setConfirming(false);
      return;
    }

    router.push(DISPUTE_ROUTES.case(result.disputeId));
  }

  return (
    <div className="space-y-5">
      <div className="border-border space-y-2 rounded-xl border p-4">
        <h2 className="text-sm font-medium">What happens next</h2>
        <ul className="text-muted space-y-1 text-sm">
          <li>The money on this job freezes straight away. Nobody is paid until it is decided.</li>
          <li>
            {otherPartyName} has {RESPONSE_HOURS} hours to give their side.
          </li>
          <li>
            One of us replies within {FIRST_RESPONSE_HOURS} hours and decides within{" "}
            {DECISION_DAYS} days.
          </li>
          <li>
            There are three possible endings: the money goes to the worker, back to the
            client, or is split.
          </li>
        </ul>
      </div>

      <TextField
        name="reason"
        label="In one line, what is this about?"
        hint="This is what we see first, in a list of everything waiting."
        value={reason}
        maxLength={REASON_MAX_LENGTH}
        error={fieldErrors.reason}
        onChange={(event) => setReason(event.target.value)}
        disabled={busy}
      />

      <TextArea
        name="statement"
        label="Your statement"
        hint={
          viewerRole === "client"
            ? "What you asked for, what you got, and what is wrong with it. Be specific — this is what the decision is made from."
            : "What you were asked for, what you sent, and why you think it meets the brief. Be specific — this is what the decision is made from."
        }
        rows={7}
        value={statement}
        maxLength={STATEMENT_MAX_LENGTH}
        error={fieldErrors.statement}
        onChange={(event) => setStatement(event.target.value)}
        footer={`${statement.length}/${STATEMENT_MAX_LENGTH}`}
        disabled={busy}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {confirming ? (
        <div className="border-danger/40 bg-danger/8 space-y-3 rounded-xl border p-4">
          <p className="text-sm">
            This opens a case on the job and freezes the money until it is decided. It
            goes on both your record and {otherPartyName}&apos;s. Are you sure?
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void submit()} disabled={busy} fullWidth={false}>
              {busy ? "Opening…" : "Yes, open the case"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              disabled={busy}
              fullWidth={false}
            >
              Back
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setConfirming(true)} fullWidth={false}>
          Open a case
        </Button>
      )}
    </div>
  );
}
