"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Alert } from "@/components/ui/Alert";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { retryFailedPayout, reviewPayoutBatch } from "@/lib/admin/decisions";
import type { PayoutFormState } from "@/lib/admin/types";

const IDLE: PayoutFormState = { status: "idle" };

/**
 * Spec §7's "batch review before each run".
 *
 * Two buttons, and the copy is careful about what approving actually does
 * today: it moves the batch to `under_review`, which is where the disbursement
 * step will pick it up. That step is not built, so nothing is about to move —
 * and a reviewer who thought otherwise would stop checking the ones that
 * follow.
 */
export function PayoutBatchForm({ batchId }: { batchId: string }) {
  const [state, formAction] = useActionState(reviewPayoutBatch, IDLE);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="batchId" value={batchId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <TextArea
        name="reason"
        label="Note"
        rows={2}
        maxLength={500}
        error={state.fieldErrors?.reason}
        hint="What you checked, or why it is being unbuilt. Audit log, permanently."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <DecisionButton
          value="approve"
          label="Approve for the run"
          variant="primary"
          detail="Marks it reviewed and ready. Nothing is sent — disbursement is not built."
        />
        <DecisionButton
          value="cancel"
          label="Unbuild it"
          variant="secondary"
          detail="Earnings go back to confirmed and roll into the next cycle."
        />
      </div>
    </form>
  );
}

function DecisionButton({
  value,
  label,
  variant,
  detail,
}: {
  value: string;
  label: string;
  variant: ButtonVariant;
  detail: string;
}) {
  const { pending } = useFormStatus();

  return (
    <div className="space-y-1.5">
      <Button
        type="submit"
        name="decision"
        value={value}
        variant={variant}
        fullWidth
        disabled={pending}
        aria-busy={pending}
      >
        {label}
      </Button>
      <p className="text-muted text-xs">{detail}</p>
    </div>
  );
}

/**
 * Spec §14's retry.
 *
 * Not a second attempt at the same transfer — the earnings return to
 * `confirmed` and the next cycle picks them up, which is what puts them back
 * through the KYC gate. A worker whose account details are still wrong is
 * skipped again rather than paid into a stranger's account.
 */
export function RetryPayoutForm({ payoutId }: { payoutId: string }) {
  const [state, formAction] = useActionState(retryFailedPayout, IDLE);

  const fieldId = `retry-reason-${payoutId}`;
  const errorId = `${fieldId}-error`;

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="payoutId" value={payoutId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      {/* Not `TextArea`: it uses the field name as its id, and this form renders
          once per failed payout. The posted name has to stay `reason`. */}
      <div className="space-y-1.5">
        <label htmlFor={fieldId} className="block text-sm font-medium">
          What was fixed
        </label>

        <input
          id={fieldId}
          name="reason"
          maxLength={500}
          placeholder="Worker re-verified their account on 14 Aug"
          aria-invalid={state.fieldErrors?.reason ? true : undefined}
          aria-describedby={state.fieldErrors?.reason ? errorId : undefined}
          className={
            "bg-surface w-full rounded-lg border px-3 py-2.5 text-sm outline-none " +
            "placeholder:text-muted/70 " +
            "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
            (state.fieldErrors?.reason
              ? "border-danger focus-visible:ring-danger"
              : "border-border focus-visible:ring-accent")
          }
        />

        {state.fieldErrors?.reason ? (
          <p id={errorId} className="text-danger text-xs">
            {state.fieldErrors.reason}
          </p>
        ) : null}
      </div>

      <RetryButton />
    </form>
  );
}

function RetryButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="secondary" disabled={pending} aria-busy={pending}>
      Return to the next cycle
    </Button>
  );
}
