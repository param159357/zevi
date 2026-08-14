"use client";

import { logOut } from "@/lib/auth/actions";
import { SubmitButton } from "@/components/auth/SubmitButton";

export function SignOutButton() {
  return (
    <form action={logOut}>
      <SubmitButton variant="ghost" fullWidth={false} pendingLabel="Signing out…">
        Sign out
      </SubmitButton>
    </form>
  );
}
