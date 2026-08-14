import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { destinationFor, getAuthContext } from "@/lib/auth/session";
import { AUTH_ROUTES, PENDING_EMAIL_COOKIE } from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";

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

  if (failure) {
    console.error(`[auth] confirmation link rejected: ${failure}`);
    return NextResponse.redirect(
      new URL(`${AUTH_ROUTES.login}?notice=link-expired`, request.url),
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

  // Supabase confirms the address before it redirects here, so a failed
  // exchange means the link was opened somewhere without the session — a phone,
  // usually. The account is fine; it just needs a password to get back in.
  if (!signedIn) {
    return NextResponse.redirect(
      new URL(`${AUTH_ROUTES.login}?notice=email-confirmed`, request.url),
    );
  }

  const context = await getAuthContext();
  const destination = context
    ? destinationFor(context.step, context.profile, context.intendedRole)
    : AUTH_ROUTES.login;

  const response = NextResponse.redirect(new URL(destination, request.url));
  response.cookies.delete(PENDING_EMAIL_COOKIE);

  return response;
}
