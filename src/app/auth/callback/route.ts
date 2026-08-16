import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { destinationFor, getAuthContext } from "@/lib/auth/session";
import {
  AUTH_ROUTES,
  PASSWORD_RECOVERY_COOKIE,
  PASSWORD_RECOVERY_COOKIE_MAX_AGE,
  PENDING_EMAIL_COOKIE,
} from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";
import { parseRedirectPath } from "@/lib/utils/validation";

const OTP_TYPES: EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && OTP_TYPES.includes(value as EmailOtpType);
}

/**
 * Where the link in the confirmation email lands.
 *
 * Handles both shapes Supabase can send: `?code=` from the default template
 * (PKCE — the verifier cookie was set when the account was created, so the link
 * has to be opened in the same browser), and `?token_hash=&type=` if the
 * template is ever switched to that form.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const failure = searchParams.get("error_description") ?? searchParams.get("error");

  // Whether this is a password reset rather than a confirmation. `type` is
  // authoritative and present on the `token_hash` shape; the PKCE shape carries
  // nothing but a code, so there `requestPasswordReset` says so by putting the
  // reset screen in `next`. Only that one destination is honoured — this is a
  // yes/no question, not a general redirect parameter.
  const isRecovery =
    type === "recovery" ||
    parseRedirectPath(searchParams.get("next")) === AUTH_ROUTES.resetPassword;

  if (failure) {
    console.error(`[auth] confirmation link rejected: ${failure}`);
    return NextResponse.redirect(
      new URL(
        isRecovery
          ? `${AUTH_ROUTES.forgotPassword}?notice=link-expired`
          : `${AUTH_ROUTES.login}?notice=link-expired`,
        request.url,
      ),
    );
  }

  const supabase = await createClient();
  let signedIn = false;

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) console.error(`[auth] code exchange failed: ${error.message}`);
    signedIn = !error;
  } else if (tokenHash && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) console.error(`[auth] token verification failed: ${error.message}`);
    signedIn = !error;
  }

  // A reset link that did not exchange leaves nothing to reset with, and the
  // login screen would be the wrong advice — the password it wants is the one
  // they came here to replace. Send them back to ask for another.
  if (!signedIn && isRecovery) {
    return NextResponse.redirect(
      new URL(`${AUTH_ROUTES.forgotPassword}?notice=link-expired`, request.url),
    );
  }

  // Supabase confirms the address before it redirects here, so a failed
  // exchange means the link was opened somewhere without the session — a phone,
  // usually. The account is fine; it just needs a password to get back in.
  if (!signedIn) {
    return NextResponse.redirect(
      new URL(`${AUTH_ROUTES.login}?notice=email-confirmed`, request.url),
    );
  }

  // Set only here, only on an exchange that succeeded: holding a session is not
  // enough to reach the reset screen, holding a live recovery link is. See
  // PASSWORD_RECOVERY_COOKIE.
  if (isRecovery) {
    const response = NextResponse.redirect(
      new URL(AUTH_ROUTES.resetPassword, request.url),
    );

    response.cookies.set(PASSWORD_RECOVERY_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: PASSWORD_RECOVERY_COOKIE_MAX_AGE,
    });

    return response;
  }

  const context = await getAuthContext();
  const destination = context
    ? destinationFor(context.step, context.profile, context.intendedRole)
    : AUTH_ROUTES.login;

  const response = NextResponse.redirect(new URL(destination, request.url));
  response.cookies.delete(PENDING_EMAIL_COOKIE);

  return response;
}
