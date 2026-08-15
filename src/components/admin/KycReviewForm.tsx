"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Alert } from "@/components/ui/Alert";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { reviewWorkerKyc } from "@/lib/admin/actions";
import { KYC_MAX_ATTEMPTS } from "@/lib/constants/kyc";
import type { KycReviewDecision, KycReviewFormState } from "@/lib/kyc/types";

const IDLE: KycReviewFormState = { status: "idle" };

const DECISIONS: {
  value: KycReviewDecision;
  label: string;
  variant: ButtonVariant;
  detail: string;
}[] = [
  {
    value: "allow_retry",
    label: "Let them try again",
    variant: "primary",
    detail: `Attempts go back to ${KYC_MAX_ATTEMPTS}. For a bank that was down or an account that has since been fixed.`,
  },
  {
    value: "reject",
    label: "Reject",
    variant: "secondary",
    detail: "Turns this round of attempts away and disables the account on file.",
  },
];

/**
 * Spec §6's "3 failed attempts → admin review", resolved.
 *
 * Two outcomes, and the one a reviewer will look for is not here: there is no
 * unblock. A blocked row is a name mismatch, spec §6 gives it no override, and
 * `review_worker_kyc()` refuses one — so this form does not offer a button that
 * would come back with an error, and the queue does not list blocked rows at
 * all. What is left to decide is whether the failures were the worker's problem
 * or the bank's.
 */
export function KycReviewForm({ workerId }: { workerId: string }) {
  const [state, formAction] = useActionState(reviewWorkerKyc, IDLE);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="workerId" value={workerId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <TextArea
        name="reason"
        label="Reason"
        rows={2}
        maxLength={500}
        error={state.fieldErrors?.reason}
        hint="Recorded in the audit log, permanently. Say what you checked."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {DECISIONS.map((decision) => (
          <DecisionButton key={decision.value} {...decision} />
        ))}
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
  value: KycReviewDecision;
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
