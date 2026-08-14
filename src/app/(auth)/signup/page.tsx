import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AuthCard } from "@/components/auth/AuthCard";
import { RoleChooser, type RoleOption } from "@/components/auth/RoleChooser";
import { destinationFor, getAuthContext } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Join Zevi" };

const OPTIONS: Array<RoleOption & { href: string }> = [
  {
    role: "client",
    title: "I need work done",
    blurb: "Post a job, pick from a shortlist, pay only once you've chosen someone.",
    href: AUTH_ROUTES.signupClient,
  },
  {
    role: "worker",
    title: "I want to do the work",
    blurb: "Show your samples, get approved, take jobs in up to three categories.",
    href: AUTH_ROUTES.signupWorker,
  },
];

export default async function SignupPage() {
  const context = await getAuthContext();

  // `choose_role` resolves to this page, so redirecting on it would loop.
  // Every other step belongs somewhere else.
  if (context && !context.isBlocked && context.step !== "choose_role") {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  const signedInWithoutRole = context?.step === "choose_role";

  return (
    <AuthCard
      title={signedInWithoutRole ? "One thing left" : "Join Zevi"}
      description={
        signedInWithoutRole
          ? "Your email and mobile are verified. How do you want to use Zevi?"
          : "Two front doors. Pick the one that fits — you can add the other later."
      }
      footer={
        signedInWithoutRole ? undefined : (
          <>
            Already have an account?{" "}
            <Link href={AUTH_ROUTES.login} className="text-foreground underline underline-offset-4">
              Sign in
            </Link>
          </>
        )
      }
    >
      {signedInWithoutRole ? (
        <RoleChooser options={OPTIONS} />
      ) : (
        <div className="space-y-3">
          {OPTIONS.map((option) => (
            <Link
              key={option.role}
              href={option.href}
              className="border-border hover:bg-surface-muted block rounded-lg border p-4 transition-colors"
            >
              <p className="text-sm font-medium">{option.title}</p>
              <p className="text-muted mt-1 text-xs">{option.blurb}</p>
            </Link>
          ))}
        </div>
      )}
    </AuthCard>
  );
}
