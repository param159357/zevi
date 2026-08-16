"use client";

import { useActionState } from "react";
import Link from "next/link";

import { SubmitButton } from "@/components/auth/SubmitButton";
import { Alert } from "@/components/ui/Alert";
import { TextField } from "@/components/ui/TextField";
import { logIn } from "@/lib/auth/actions";
import { IDLE_FORM_STATE } from "@/lib/auth/types";
import { AUTH_ROUTES } from "@/lib/constants/auth";

export function LoginForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState(logIn, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {state.error ? <Alert tone="error">{state.error}</Alert> : null}

      {next ? <input type="hidden" name="next" value={next} /> : null}

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

      <div className="space-y-1.5">
        <TextField
          name="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          error={state.fieldErrors?.password}
        />

        <Link
          href={AUTH_ROUTES.forgotPassword}
          className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
        >
          Forgot your password?
        </Link>
      </div>

      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}
