import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";

import { AuthCard } from "@/components/auth/AuthCard";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { Alert } from "@/components/ui/Alert";
import { getAuthContext } from "@/lib/auth/session";
import { AUTH_ROUTES, PASSWORD_RECOVERY_COOKIE } from "@/lib/constants/auth";

export const metadata: Metadata = { title: "Set a new password · Zevi" };

/**
 * Deliberately absent from the middleware's signed-in-only list: someone whose
 * link has gone stale needs to be told that, not bounced to a login screen
 * asking for the password they came here to replace.
 *
 * Two things have to be true to see the form — a session, and the marker the
 * callback writes when a recovery link exchanges. The marker is what stops this
 * being a no-old-password door on every signed-in session; `setNewPassword`
 * checks for it again, because a rendered form is not access control.
 */
export default async function ResetPasswordPage() {
  const store = await cookies();
  const context = await getAuthContext();
  const recovering = Boolean(store.get(PASSWORD_RECOVERY_COOKIE));

  if (!context || !recovering) {
    return (
      <AuthCard
        title="That link has expired"
        description="Reset links are good for one use, and only in the browser that asked for them."
        footer={
          <>
            Know your password?{" "}
            <Link
              href={AUTH_ROUTES.login}
              className="text-foreground underline underline-offset-4"
            >
              Sign in
            </Link>
          </>
        }
      >
        <div className="space-y-4">
          <Alert tone="info">
            Ask for another link and open it in this browser — it carries the reset back to
            this tab.
          </Alert>

          <Link
            href={AUTH_ROUTES.forgotPassword}
            className="text-foreground text-sm underline underline-offset-4"
          >
            Send another link
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set a new password"
      description={`For ${context.profile.email}.`}
    >
      <ResetPasswordForm />
    </AuthCard>
  );
}
