import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { EmailVerification } from "@/components/auth/EmailVerification";
import { destinationFor, getAuthContext } from "@/lib/auth/session";
import { AUTH_ROUTES, PENDING_EMAIL_COOKIE } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Confirm your email · Zevi" };

/**
 * Reachable without a session: confirmation is required before Supabase issues
 * one, so this screen runs on the cookie left behind at signup.
 */
export default async function VerifyEmailPage() {
  const context = await getAuthContext();

  // Someone who has already confirmed — a stale tab, a second click on the
  // link — belongs at the next step, not on a screen asking for what's done.
  if (context && !context.isBlocked && context.step !== "verify_email") {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  const store = await cookies();

  const email = context?.profile.email ?? store.get(PENDING_EMAIL_COOKIE)?.value ?? null;

  return (
    <AuthCard
      title="Confirm your email"
      description="Step 1 of 2. Mobile comes next."
      footer={
        <>
          Already confirmed?{" "}
          <Link href={AUTH_ROUTES.login} className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <EmailVerification email={email} />
    </AuthCard>
  );
}
