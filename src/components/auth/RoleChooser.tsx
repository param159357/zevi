"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { chooseRole } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";

export type RoleOption = {
  role: "client" | "worker";
  title: string;
  blurb: string;
};

/**
 * Recovery path only: a verified account that has no role record yet, because
 * signup was interrupted somewhere between the two verifications.
 */
export function RoleChooser({ options }: { options: RoleOption[] }) {
  const [state, formAction] = useActionState(chooseRole, IDLE_FORM_STATE);

  return (
    <div className="space-y-3">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      {options.map((option) => (
        <form
          key={option.role}
          action={formAction}
          className="border-border rounded-lg border p-4"
        >
          <input type="hidden" name="role" value={option.role} />
          <p className="text-sm font-medium">{option.title}</p>
          <p className="text-muted mt-1 mb-3 text-xs">{option.blurb}</p>
          <SubmitButton variant="secondary" pendingLabel="Setting up…">
            Continue
          </SubmitButton>
        </form>
      ))}
    </div>
  );
}
