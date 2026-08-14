import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/AuthCard";
import { SignupForm } from "@/components/auth/SignupForm";
import { redirectSignedInAway } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Post work on Zevi" };

export default async function ClientSignupPage() {
  await redirectSignedInAway();

  return (
    <AuthCard
      title="Create a client account"
      description="Posting a job is free. You only pay when you pick someone."
      footer={
        <>
          Want to do the work instead?{" "}
          <Link
            href={AUTH_ROUTES.signupWorker}
            className="text-foreground underline underline-offset-4"
          >
            Sign up as a worker
          </Link>
        </>
      }
    >
      <SignupForm role="client" />
    </AuthCard>
  );
}
