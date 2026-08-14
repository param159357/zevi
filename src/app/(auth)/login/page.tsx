import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Alert } from "@/components/ui/Alert";
import { getAuthContext, redirectSignedInAway } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";
import { parseRedirectPath } from "@/lib/utils/validation";

export const metadata: Metadata = { title: "Sign in · Zevi" };

const NOTICES: Record<string, { tone: "info" | "success"; message: string }> = {
  "email-confirmed": {
    tone: "success",
    message: "Your email is confirmed. Sign in to pick up where you left off.",
  },
  "link-expired": {
    tone: "info",
    message: "That confirmation link has expired. Sign in and we'll send a fresh one.",
  },
  blocked: {
    tone: "info",
    message: "This account can't be used at the moment. Write to support for the reason.",
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; notice?: string }>;
}) {
  const { next, notice } = await searchParams;

  // A blocked account is deliberately left here rather than bounced onward.
  await redirectSignedInAway();
  const stranded = await getAuthContext();

  const banner = notice ? NOTICES[notice] : undefined;
  const safeNext = parseRedirectPath(next);

  return (
    <AuthCard
      title="Sign in"
      description="Welcome back."
      footer={
        <>
          New here?{" "}
          <Link href={AUTH_ROUTES.signup} className="text-foreground underline underline-offset-4">
            Create an account
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {banner ? <Alert tone={banner.tone}>{banner.message}</Alert> : null}

        {stranded ? (
          <div className="space-y-3">
            <Alert tone="error">
              You&apos;re signed in as {stranded.profile.email}, but this account is suspended or
              closed.
            </Alert>
            <SignOutButton />
          </div>
        ) : (
          <LoginForm next={safeNext ?? undefined} />
        )}
      </div>
    </AuthCard>
  );
}
