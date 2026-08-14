"use client";

import { useActionState } from "react";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { TextField } from "@/components/ui/TextField";
import { signUpAsClient, signUpAsWorker } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";
import { PASSWORD_MIN_LENGTH } from "@/lib/constants/auth";

export function SignupForm({ role }: { role: "client" | "worker" }) {
  const [state, formAction] = useActionState(
    role === "client" ? signUpAsClient : signUpAsWorker,
    IDLE_FORM_STATE,
  );

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      <TextField
        name="fullName"
        label="Full name"
        hint={
          role === "worker"
            ? "Exactly as it appears on your ID — it has to match your bank account before your first payout."
            : undefined
        }
        autoComplete="name"
        autoCapitalize="words"
        required
        error={state.fieldErrors?.fullName}
      />

      <TextField
        name="email"
        label="Email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        error={state.fieldErrors?.email}
      />

      <TextField
        name="mobile"
        label="Mobile"
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        prefix="+91"
        placeholder="98765 43210"
        required
        error={state.fieldErrors?.mobile}
      />

      <TextField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={PASSWORD_MIN_LENGTH}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        required
        error={state.fieldErrors?.password}
      />

      <SubmitButton pendingLabel="Creating your account…">Create account</SubmitButton>

      <p className="text-muted text-xs">
        We verify both your email and your mobile before you can post or take work.
      </p>
    </form>
  );
}
