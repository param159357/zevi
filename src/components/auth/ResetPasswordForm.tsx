"use client";

import { useActionState } from "react";
import Link from "next/link";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { TextField } from "@/components/ui/TextField";
import { setNewPassword } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";
import { AUTH_ROUTES, PASSWORD_MIN_LENGTH } from "@/lib/constants/auth";

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(setNewPassword, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error ? (
        <Alert tone="error">
          {state.error}{" "}
          <Link
            href={AUTH_ROUTES.forgotPassword}
            className="text-foreground underline underline-offset-4"
          >
            Start again
          </Link>
        </Alert>
      ) : null}

      <TextField
        name="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        required
        error={state.fieldErrors?.password}
      />

      <TextField
        name="confirmPassword"
        label="New password again"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword}
      />

      <SubmitButton pendingLabel="Saving…">Set the new password</SubmitButton>

      <p className="text-muted text-xs">
        Anywhere else you were signed in will be signed out.
      </p>
    </form>
  );
}
