"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { TextArea } from "@/components/ui/TextArea";
import { TextField } from "@/components/ui/TextField";
import { liftSanction, sanctionUser } from "@/lib/admin/decisions";
import type { SanctionFormState, SanctionType } from "@/lib/admin/types";

const IDLE: SanctionFormState = { status: "idle" };

const CHOICES: { value: SanctionType; label: string; detail: string }[] = [
  {
    value: "warning",
    label: "Warn",
    detail: "On the record. Nothing about the account changes — that is what makes it a warning.",
  },
  {
    value: "suspension",
    label: "Suspend",
    detail: "They cannot sign in until it expires or you lift it.",
  },
  {
    value: "ban",
    label: "Ban",
    detail: "Permanent. Lift it here if it was a mistake; there is no other way back.",
  },
];

/**
 * Spec §7: "Warn · suspend · ban. Every action logged with reason."
 *
 * The reason is required on all three and is shown to the user, so it is
 * written as copy rather than as a case number. The internal note is the second
 * field for everything you would not put in front of them.
 *
 * A console member cannot be sanctioned from here — `apply_user_sanction()`
 * refuses one — so the screen above this hides the form entirely rather than
 * offering a button that comes back with an error.
 */
export function SanctionForm({ profileId }: { profileId: string }) {
  const [state, formAction] = useActionState(sanctionUser, IDLE);
  const [type, setType] = useState<SanctionType>("warning");

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="profileId" value={profileId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Action</legend>

        <div className="grid gap-2 sm:grid-cols-3">
          {CHOICES.map((choice) => (
            <label
              key={choice.value}
              className={
                "border-border hover:bg-surface-muted flex cursor-pointer gap-2.5 rounded-lg border p-3 transition-colors " +
                (type === choice.value ? "border-accent bg-surface-muted" : "")
              }
            >
              <input
                type="radio"
                name="type"
                value={choice.value}
                checked={type === choice.value}
                onChange={() => setType(choice.value)}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{choice.label}</span>
                <span className="text-muted block text-xs">{choice.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {type === "suspension" ? (
        <TextField
          name="durationDays"
          label="For how many days"
          type="number"
          min={1}
          max={365}
          placeholder="Leave blank to suspend until you lift it"
          error={state.fieldErrors?.durationDays}
          hint="Whole days. Blank means indefinite — for an investigation with no known end date."
        />
      ) : null}

      <TextArea
        name="reason"
        label="Reason"
        rows={2}
        maxLength={500}
        error={state.fieldErrors?.reason}
        hint="The account holder is shown this. Write it to them."
      />

      <TextArea
        name="internalNote"
        label="Internal note"
        rows={2}
        maxLength={2000}
        hint="Optional, and never shown to them. Everything you would not put in the sentence above."
      />

      <SubmitButton type={type} />
    </form>
  );
}

function SubmitButton({ type }: { type: SanctionType }) {
  const { pending } = useFormStatus();
  const label = type === "warning" ? "Warn" : type === "suspension" ? "Suspend" : "Ban";

  return (
    <Button
      type="submit"
      variant={type === "ban" ? "secondary" : "primary"}
      disabled={pending}
      aria-busy={pending}
    >
      {label} this account
    </Button>
  );
}

/**
 * The way back. Lifting one sanction returns the account to active only if
 * nothing else is still holding it down — two overlapping suspensions lifted one
 * at a time must not let the first lift undo the second, and
 * `lift_user_sanction()` is what checks.
 */
export function LiftSanctionForm({
  sanctionId,
  profileId,
}: {
  sanctionId: string;
  profileId: string;
}) {
  const [state, formAction] = useActionState(liftSanction, IDLE);

  // Not `TextField`: that primitive uses the field's name as its id, and an
  // account with two live sanctions renders two of these. The posted name has
  // to stay `liftReason` for the action to find it, so the id is what varies.
  const fieldId = `lift-reason-${sanctionId}`;
  const errorId = `${fieldId}-error`;

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="sanctionId" value={sanctionId} />
      <input type="hidden" name="profileId" value={profileId} />

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <div className="space-y-1.5">
        <label htmlFor={fieldId} className="block text-sm font-medium">
          Why it is being lifted
        </label>

        <input
          id={fieldId}
          name="liftReason"
          maxLength={500}
          aria-invalid={state.fieldErrors?.liftReason ? true : undefined}
          aria-describedby={state.fieldErrors?.liftReason ? errorId : undefined}
          className={
            "bg-surface w-full rounded-lg border px-3 py-2.5 text-sm outline-none " +
            "focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
            (state.fieldErrors?.liftReason
              ? "border-danger focus-visible:ring-danger"
              : "border-border focus-visible:ring-accent")
          }
        />

        {state.fieldErrors?.liftReason ? (
          <p id={errorId} className="text-danger text-xs">
            {state.fieldErrors.liftReason}
          </p>
        ) : null}
      </div>

      <LiftButton />
    </form>
  );
}

function LiftButton() {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="secondary" disabled={pending} aria-busy={pending}>
      Lift
    </Button>
  );
}
