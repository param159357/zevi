"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { TextField } from "@/components/ui/TextField";
import { requestPasswordReset } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";

export function ForgotPasswordForm({ email }: { email?: string }) {
  const [state, formAction] = useActionState(requestPasswordReset, IDLE_FORM_STATE);

  // The notice says "if that address has an account", so it is safe to show for
  // an address that has none — which is the point of showing the same thing
  // either way. The form stays up underneath it for a typo in the address.
  return (
    <div className="space-y-4">
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <form action={formAction} className="space-y-4" noValidate>
        <TextField
          name="email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          defaultValue={email}
          required
          error={state.fieldErrors?.email}
        />

        <SubmitButton pendingLabel="Sending…">
          {state.status === "sent" ? "Send it again" : "Send the link"}
        </SubmitButton>
      </form>

      <p className="text-muted text-xs">
        Open the link in this browser — it carries the reset back to this tab. Check spam if
        it hasn&apos;t arrived within a minute.
      </p>
    </div>
  );
}
