"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { resendEmailVerification } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";

export function EmailVerification({ email }: { email: string | null }) {
  const [state, formAction] = useActionState(resendEmailVerification, IDLE_FORM_STATE);

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {email ? (
          <>
            We sent a confirmation link to <span className="font-medium">{email}</span>. Open
            it and you&apos;ll come straight back here.
          </>
        ) : (
          <>Open the confirmation link we emailed you and you&apos;ll come straight back here.</>
        )}
      </p>

      {state.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state.notice ? <Alert tone="success">{state.notice}</Alert> : null}

      <form action={formAction}>
        <SubmitButton variant="secondary" pendingLabel="Sending…">
          Send the link again
        </SubmitButton>
      </form>

      <p className="text-muted text-xs">
        Check spam if it hasn&apos;t arrived within a minute. Open the link in this browser —
        it carries the session back to this tab.
      </p>
    </div>
  );
}
