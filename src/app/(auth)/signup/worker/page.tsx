import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/AuthCard";
import { SignupForm } from "@/components/auth/SignupForm";
import { redirectSignedInAway } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Work on Zevi" };

export default async function WorkerSignupPage() {
  await redirectSignedInAway();

  return (
    <AuthCard
      title="Create a worker account"
      description="Verify your email and mobile, pick your categories, then add samples for review."
      footer={
        <>
          Looking to hire instead?{" "}
          <Link
            href={AUTH_ROUTES.signupClient}
            className="text-foreground underline underline-offset-4"
          >
            Sign up as a client
          </Link>
        </>
      }
    >
      <SignupForm role="worker" />
    </AuthCard>
  );
}
