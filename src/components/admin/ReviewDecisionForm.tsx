"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { Alert } from "@/components/ui/Alert";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { reviewWorkerApplication } from "@/lib/admin/actions";
import { IDLE_REVIEW_STATE, type ReviewDecision } from "@/lib/admin/types";
import { RESUBMIT_AFTER_DAYS } from "@/lib/constants/workers";

const DECISIONS: {
  value: ReviewDecision;
  label: string;
  variant: ButtonVariant;
  detail: string;
}[] = [
  {
    value: "approve",
    label: "Approve",
    variant: "primary",
    detail: "Their categories' jobs appear in their feed straight away.",
  },
  {
    value: "approve_with_flag",
    label: "Approve with flag",
    variant: "secondary",
    detail: "Same access, but their first delivery is watched.",
  },
  {
    value: "reject",
    label: "Reject",
    variant: "secondary",
    detail: `They see the reason and may resubmit once, after ${RESUBMIT_AFTER_DAYS} days.`,
  },
];

/**
 * The three outcomes in spec §6. Each is a submit button carrying its own
 * value, so there is no selected-then-confirm state to get out of step with
 * what the button says.
 *
 * The reason is required on all three: the audit row spec §7 mandates has
 * nowhere else to get one, and on a rejection it is what the worker is shown.
 */
export function ReviewDecisionForm({ applicationId }: { applicationId: string }) {
  const [state, formAction] = useActionState(reviewWorkerApplication, IDLE_REVIEW_STATE);

  return (
    <form action={formAction} className="border-border space-y-4 rounded-xl border p-4 sm:p-5">
      <input type="hidden" name="applicationId" value={applicationId} />

      <h2 className="text-base font-semibold">Decision</h2>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <TextArea
        name="reason"
        label="Reason"
        rows={3}
        maxLength={500}
        error={state.fieldErrors?.reason}
        hint="Recorded in the audit log, permanently. On a rejection this is what the worker reads, so write it to them."
      />

      <TextArea
        name="internalNote"
        label="Internal note"
        rows={2}
        maxLength={2000}
        hint="Optional, and never shown to the worker."
      />

      <div className="grid gap-3 sm:grid-cols-3">
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
  value: ReviewDecision;
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
