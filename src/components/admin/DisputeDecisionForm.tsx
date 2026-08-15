"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { TextField } from "@/components/ui/TextField";
import { resolveDispute } from "@/lib/admin/decisions";
import type { DisputeFormState, DisputeOutcome } from "@/lib/admin/types";
import { formatPaise } from "@/lib/utils/money";

const IDLE: DisputeFormState = { status: "idle" };

/**
 * Spec §11's three outcomes, and no fourth.
 *
 * The reviewer picks the outcome first and the note is required either way,
 * which is spec §7's "required internal note on every decision" — including on
 * a release, which is the one people would skip. Six months later the note is
 * the only thing that says why.
 *
 * The split share is a percentage of the *budget*, shown resolved into rupees
 * as it is typed. Basis points are what the column stores and are nobody's unit
 * of thought; a reviewer who means "give the client 60%" should see ₹600 of
 * ₹1,000 before they commit to it.
 */
export function DisputeDecisionForm({
  disputeId,
  budgetPaise,
  escrowHeldPaise,
  canResolve,
}: {
  disputeId: string;
  budgetPaise: number;
  escrowHeldPaise: number | null;
  canResolve: boolean;
}) {
  const [state, formAction] = useActionState(resolveDispute, IDLE);
  const [outcome, setOutcome] = useState<DisputeOutcome | null>(null);
  const [clientPercent, setClientPercent] = useState(50);

  if (!canResolve) {
    return (
      <Alert tone="info">
        You can read this case but not decide it. Deciding needs the
        <code className="mx-1 text-xs">resolve_disputes</code> permission.
      </Alert>
    );
  }

  if (escrowHeldPaise === null) {
    return (
      <Alert tone="error">
        Escrow on this job is no longer held, so there is nothing here to divide. A dispute
        raised after acceptance needs the worker&rsquo;s earning reversed, which is not built —
        this one has to be settled by hand.
      </Alert>
    );
  }

  const clientShare = Math.floor((budgetPaise * Math.round(clientPercent)) / 100);
  const workerShare = budgetPaise - clientShare;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="disputeId" value={disputeId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Outcome</legend>

        <div className="grid gap-2 sm:grid-cols-3">
          <OutcomeChoice
            value="release"
            label="Release"
            detail={`All ${formatPaise(budgetPaise)} to the worker.`}
            checked={outcome === "release"}
            onSelect={setOutcome}
          />
          <OutcomeChoice
            value="refund"
            label="Refund"
            detail={`All ${formatPaise(budgetPaise)} back to the client.`}
            checked={outcome === "refund"}
            onSelect={setOutcome}
          />
          <OutcomeChoice
            value="split"
            label="Split"
            detail="Divide it between them."
            checked={outcome === "split"}
            onSelect={setOutcome}
          />
        </div>
      </fieldset>

      {outcome === "split" ? (
        <div className="border-border space-y-2 rounded-lg border p-3">
          <TextField
            name="clientPercent"
            label="The client's share"
            type="number"
            min={0}
            max={100}
            step={1}
            value={clientPercent}
            onChange={(event) => setClientPercent(Number(event.target.value))}
            error={state.fieldErrors?.clientPercent}
            hint="Whole percents. The rest goes to the worker."
          />
          <p className="text-muted text-sm">
            Client {formatPaise(clientShare)} · worker {formatPaise(workerShare)}, before the
            worker&rsquo;s commission and GST come out of their half.
          </p>
        </div>
      ) : null}

      <TextArea
        name="decisionNote"
        label="Internal note"
        rows={3}
        maxLength={2000}
        error={state.fieldErrors?.decisionNote}
        hint="Required on every outcome, including a release. Permanent, and read against both histories later."
      />

      {outcome === "refund" || outcome === "split" ? (
        <Alert tone="info">
          The client&rsquo;s share becomes a queued refund. Razorpay&rsquo;s refund API is not
          wired up, so the money does not leave the platform account today — the refund row is
          the instruction, and someone has to carry it out.
        </Alert>
      ) : null}

      <SubmitButton outcome={outcome} />
    </form>
  );
}

function OutcomeChoice({
  value,
  label,
  detail,
  checked,
  onSelect,
}: {
  value: DisputeOutcome;
  label: string;
  detail: string;
  checked: boolean;
  onSelect: (value: DisputeOutcome) => void;
}) {
  return (
    <label
      className={
        "border-border hover:bg-surface-muted flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors " +
        (checked ? "border-accent bg-surface-muted" : "")
      }
    >
      <input
        type="radio"
        name="outcome"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{label}</span>
        <span className="text-muted block text-xs">{detail}</span>
      </span>
    </label>
  );
}

function SubmitButton({ outcome }: { outcome: DisputeOutcome | null }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={pending || outcome === null} aria-busy={pending}>
      {outcome === null ? "Pick an outcome" : `Decide: ${outcome}`}
    </Button>
  );
}
