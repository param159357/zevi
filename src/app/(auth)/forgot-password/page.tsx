import type { Metadata } from "next";
import Link from "next/link";

import { AuthCard } from "@/components/auth/AuthCard";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";
import { Alert } from "@/components/ui/Alert";
import { getAuthContext } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Reset your password · Zevi" };

const NOTICES: Record<string, { tone: "info" | "success"; message: string }> = {
  "link-expired": {
    tone: "info",
    message:
      "That reset link has expired or was opened somewhere else. Ask for another and open it in this browser.",
  },
};

/**
 * Reachable signed out, which is the whole point, and deliberately not
 * `redirectSignedInAway` — see `requestPasswordReset`. Clients and workers share
 * it: the account is one row in `profiles` either way, and where the reset lands
 * afterwards is `destinationFor`'s decision, not this screen's.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const context = await getAuthContext();

  const banner = notice ? NOTICES[notice] : undefined;

  return (
    <AuthCard
      title="Reset your password"
      description="We'll email you a link to set a new one."
      footer={
        <>
          Remembered it?{" "}
          <Link href={AUTH_ROUTES.login} className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        {banner ? <Alert tone={banner.tone}>{banner.message}</Alert> : null}

        <ForgotPasswordForm email={context?.profile.email ?? undefined} />
      </div>
    </AuthCard>
  );
}
