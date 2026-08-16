"use server";

/**
 * Signup, login and verification.
 *
 * Spec §5 and §6: email and mobile, both compulsory and both verified, with a
 * separate front door for Clients and Workers. Email verification is Supabase
 * Auth's; mobile is ours, and every limit on it lives in the two database
 * functions this module calls with the service-role key.
 *
 * Rules that hold everywhere below:
 *   * every action re-derives the caller from the session — never from a form
 *     field, never from `user_metadata`, which the user can edit
 *   * the mobile number is not written to `profiles` until an OTP proves it
 *   * a Supabase error is logged in full and shown as a sentence
 */

import { randomInt } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";

import {
  AUTH_ROUTES,
  MAX_WORKER_CATEGORIES,
  NON_WORKER_CATEGORY_SLUGS,
  OTP_LENGTH,
  OTP_RESEND_COOLDOWN_SECONDS,
  PASSWORD_RECOVERY_COOKIE,
  PENDING_EMAIL_COOKIE,
  PENDING_EMAIL_COOKIE_MAX_AGE,
} from "@/lib/constants/auth";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { notifyPasswordChanged } from "@/lib/email/events";
import { getSiteUrl } from "@/lib/env";
import { SmsNotConfiguredError, sendVerificationSms } from "@/lib/sms/send";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  type AccountRole,
  type AuthContext,
  type AuthProfile,
  destinationFor,
  getAuthContext,
  isBlockedProfile,
  loadProfile,
  readIntendedRole,
  resolveStep,
} from "@/lib/auth/session";
import type { FormState } from "@/lib/auth/types";
import {
  formatMobile,
  parseEmail,
  parseFullName,
  parseIpAddress,
  parseMobile,
  parseOtp,
  parsePassword,
  parseRedirectPath,
} from "@/lib/utils/validation";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function fieldError(name: string, message: string): FormState {
  return { status: "error", fieldErrors: { [name]: message } };
}

function describeAuthError(error: AuthError): string {
  console.error(`[auth] ${error.code ?? error.status ?? "unknown"}: ${error.message}`);

  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match an account.";
    case "email_not_confirmed":
      return "Confirm your email address first — the link is in your inbox.";
    case "weak_password":
      return "That password is too easy to guess. Try a longer one.";
    // Supabase rejects unroutable and disposable domains before we ever see them.
    case "email_address_invalid":
    case "email_address_not_authorized":
      return "We can't send mail to that address. Try another one.";
    case "validation_failed":
      return "Check the details above and try again.";
    case "signup_disabled":
      return "Signups are closed at the moment.";
    case "user_banned":
      return "This account has been closed. Write to support if that's a mistake.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      return error.status === 429
        ? "Too many attempts. Wait a few minutes and try again."
        : "Something went wrong on our side. Try again.";
  }
}

function blockedMessage(profile: AuthProfile): string {
  if (profile.status === "banned") {
    return "This account has been closed. Write to support if that's a mistake.";
  }

  const until = profile.suspended_until
    ? new Date(profile.suspended_until).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return until
    ? `This account is suspended until ${until}.`
    : "This account is suspended. Write to support for the reason.";
}

async function clientIpAddress(): Promise<string | null> {
  const headerList = await headers();

  return parseIpAddress(
    headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  );
}

/** Carries the address to the "check your inbox" screen, which has no session
 *  to read it from. httpOnly so it is never a value the page can be tricked
 *  into echoing. */
async function rememberPendingEmail(email: string): Promise<void> {
  const store = await cookies();

  store.set(PENDING_EMAIL_COOKIE, email, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PENDING_EMAIL_COOKIE_MAX_AGE,
  });
}

/**
 * `client_profiles` and `worker_profiles` are inserted by the user under RLS —
 * `mark_profile_as_client` and `create_worker_state` do the rest. Idempotent:
 * the flow can pass through here more than once.
 */
async function ensureRoleRecord(role: AccountRole, userId: string): Promise<void> {
  const supabase = await createClient();

  const { error } =
    role === "client"
      ? await supabase.from("client_profiles").insert({ profile_id: userId })
      : await supabase.from("worker_profiles").insert({ profile_id: userId });

  // 23505: the row is already there, which is the state we wanted.
  if (error && error.code !== "23505") {
    throw new Error(`Could not create the ${role} record for ${userId}: ${error.message}`);
  }
}

/** Guard shared by every action that runs after the account exists. */
async function requireContext(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) redirect(AUTH_ROUTES.login);
  return context;
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

async function signUp(role: AccountRole, formData: FormData): Promise<FormState> {
  const fullName = parseFullName(formData.get("fullName"));
  const email = parseEmail(formData.get("email"));
  const mobile = parseMobile(formData.get("mobile"));
  const password = parsePassword(formData.get("password"));

  if (!fullName.ok || !email.ok || !mobile.ok || !password.ok) {
    return {
      status: "error",
      fieldErrors: {
        ...(fullName.ok ? {} : { fullName: fullName.error }),
        ...(email.ok ? {} : { email: email.error }),
        ...(mobile.ok ? {} : { mobile: mobile.error }),
        ...(password.ok ? {} : { password: password.error }),
      },
    };
  }

  // Catching a taken number now rather than after the email round trip, which
  // would strand a verified account on a number it can never confirm. Only
  // verified numbers count — an unverified one is never written at all.
  const admin = createServiceRoleClient();
  const { data: existing, error: lookupError } = await admin
    .from("profiles")
    .select("id")
    .eq("mobile", mobile.value)
    .not("mobile_verified_at", "is", null)
    .limit(1);

  if (lookupError) {
    throw new Error(`Mobile availability check failed: ${lookupError.message}`);
  }

  if (existing && existing.length > 0) {
    return fieldError("mobile", "That mobile number is already registered.");
  }

  const signupIp = await clientIpAddress();
  const supabase = await createClient();

  const { error } = await supabase.auth.signUp({
    email: email.value,
    password: password.value,
    options: {
      emailRedirectTo: `${getSiteUrl()}${AUTH_ROUTES.callback}`,
      data: {
        full_name: fullName.value,
        intended_role: role,
        pending_mobile: mobile.value,
        ...(signupIp ? { signup_ip: signupIp } : {}),
      },
    },
  });

  // An address that already has an account gets the same screen as a new one.
  // Confirming which is which to an unauthenticated caller is an account
  // enumeration oracle.
  if (error && error.code !== "user_already_exists") {
    return { status: "error", error: describeAuthError(error) };
  }

  await rememberPendingEmail(email.value);
  redirect(AUTH_ROUTES.verifyEmail);
}

export async function signUpAsClient(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return signUp("client", formData);
}

export async function signUpAsWorker(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  return signUp("worker", formData);
}

// ---------------------------------------------------------------------------
// Login and logout
// ---------------------------------------------------------------------------

export async function logIn(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = parseEmail(formData.get("email"));
  const password = formData.get("password");

  if (!email.ok) return fieldError("email", email.error);
  if (typeof password !== "string" || password.length === 0) {
    return fieldError("password", "Enter your password.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.value,
    password,
  });

  if (error?.code === "email_not_confirmed") {
    await rememberPendingEmail(email.value);
    redirect(AUTH_ROUTES.verifyEmail);
  }

  if (error) {
    return { status: "error", error: describeAuthError(error) };
  }

  const profile = await loadProfile(supabase, data.user.id);

  // Signing a blocked account straight back out keeps it off every product
  // page without a guard that can bounce it into a redirect loop.
  if (isBlockedProfile(profile)) {
    await supabase.auth.signOut();
    return { status: "error", error: blockedMessage(profile) };
  }

  const step = resolveStep(data.user, profile);
  const next = parseRedirectPath(formData.get("next"));

  redirect(
    step === "complete" && next
      ? next
      : destinationFor(step, profile, readIntendedRole(data.user)),
  );
}

export async function logOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/");
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Sends the recovery link.
 *
 * The message is Supabase Auth's, not one we compose, for the same reason the
 * confirmation email is (see `lib/email/templates/client.ts`): the token in it
 * is GoTrue's to mint, and pointing Supabase's SMTP at SES puts it under the
 * same SPF and DKIM as everything else. `docs/email-setup.md` §8 is the runbook.
 *
 * A signed-in caller is not turned away. There is no change-password screen
 * inside the product, and an inbox round trip is the right proof for a password
 * change anyway — so this doubles as that path until one exists.
 */
export async function requestPasswordReset(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const email = parseEmail(formData.get("email"));
  if (!email.ok) return fieldError("email", email.error);

  // The address is the answer to "who asked?", so it goes back on the state and
  // the screen can name it. `next` is what tells the callback this is a
  // recovery: it decides which screen the link lands on and nothing else.
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.value, {
    redirectTo: `${getSiteUrl()}${AUTH_ROUTES.callback}?next=${encodeURIComponent(AUTH_ROUTES.resetPassword)}`,
  });

  // An address with no account gets the same screen as one with. Anything else
  // is an enumeration oracle, and this form is open to the world — the copy on
  // the screen says "if that address has an account" for the same reason.
  if (error && error.code !== "user_not_found") {
    return { status: "error", error: describeAuthError(error) };
  }

  return {
    status: "sent",
    notice: `If ${email.value} has an account, a link to set a new password is on its way.`,
  };
}

/**
 * Sets the new password, for a session that arrived through a recovery link.
 *
 * The marker cookie is the whole guard: Supabase hands back an ordinary session
 * on a recovery exchange, so without it this action would change the password
 * of whoever holds the session cookie, no old password asked for. See
 * `PASSWORD_RECOVERY_COOKIE`.
 */
export async function setNewPassword(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const store = await cookies();
  const expired: FormState = {
    status: "error",
    error: "That reset link has expired. Ask for a fresh one and open it in this browser.",
  };

  if (!store.get(PASSWORD_RECOVERY_COOKIE)) return expired;

  const password = parsePassword(formData.get("password"));
  if (!password.ok) return fieldError("password", password.error);

  // Typed twice because a mistyped password on this screen locks the account out
  // of itself — there is no old password left to fall back on.
  if (formData.get("confirmPassword") !== password.value) {
    return fieldError("confirmPassword", "Those two don't match.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.updateUser({ password: password.value });

  if (error) {
    switch (error.code) {
      case "same_password":
        return fieldError("password", "That's the password you already have. Pick a different one.");
      // The session went stale while the form was open, or the link was already
      // spent. Either way there is nothing to do here but start again.
      case "session_not_found":
      case "session_expired":
      case "reauthentication_needed":
        return expired;
      default:
        return { status: "error", error: describeAuthError(error) };
    }
  }

  // Spent. A second submission from a stale tab starts over rather than getting
  // a free password change.
  store.delete(PASSWORD_RECOVERY_COOKIE);

  // Somebody resetting a password is often resetting it *because* someone else
  // has it. Leaving the other sessions alive would hand the account back.
  // 'others' deliberately: this browser keeps the session it just proved.
  const { error: signOutError } = await supabase.auth.signOut({ scope: "others" });
  if (signOutError) {
    // The password has already changed, so there is nothing to unwind and
    // failing the action now would tell the user something untrue.
    console.error(`[auth] could not sign other sessions out: ${signOutError.message}`);
  }

  // Queued before the blocked check below, and before any redirect: a suspended
  // account whose password was changed is still an account whose owner should
  // hear about it, and the notice is worth nothing if it only goes out on the
  // paths that end well. `notifyPasswordChanged` cannot throw.
  await notifyPasswordChanged({
    profileId: data.user.id,
    changedAtIso: data.user.updated_at ?? new Date().toISOString(),
  });

  const profile = await loadProfile(supabase, data.user.id);

  if (isBlockedProfile(profile)) {
    await supabase.auth.signOut();
    return { status: "error", error: blockedMessage(profile) };
  }

  redirect(
    destinationFor(
      resolveStep(data.user, profile),
      profile,
      readIntendedRole(data.user),
    ),
  );
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

export async function resendEmailVerification(
  _previous: FormState,
  _formData: FormData,
): Promise<FormState> {
  const store = await cookies();
  const context = await getAuthContext();
  const address = context?.profile.email ?? store.get(PENDING_EMAIL_COOKIE)?.value ?? null;

  if (!address) {
    return {
      status: "error",
      error: "We've lost track of which address to send to. Sign in and we'll try again.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: address,
    options: { emailRedirectTo: `${getSiteUrl()}${AUTH_ROUTES.callback}` },
  });

  if (error) return { status: "error", error: describeAuthError(error) };

  return { status: "sent", notice: `Sent again to ${address}.` };
}

// ---------------------------------------------------------------------------
// Mobile verification
// ---------------------------------------------------------------------------

async function requireMobileStep(): Promise<AuthContext> {
  const context = await requireContext();

  if (context.step === "verify_email") redirect(AUTH_ROUTES.verifyEmail);
  if (context.profile.mobile_verified_at) {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  return context;
}

export async function sendMobileOtp(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await requireMobileStep();

  const submitted = formData.get("mobile");
  const mobile = parseMobile(
    typeof submitted === "string" && submitted.trim() ? submitted : context.pendingMobile,
  );

  if (!mobile.ok) return fieldError("mobile", mobile.error);

  const code = randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, "0");

  const requestIp = await clientIpAddress();
  const admin = createServiceRoleClient();

  const { data, error } = await admin
    .rpc("request_phone_verification", {
      p_profile_id: context.user.id,
      p_mobile: mobile.value,
      p_otp: code,
      ...(requestIp ? { p_request_ip: requestIp } : {}),
    })
    .single();

  if (error) {
    throw new Error(`request_phone_verification failed: ${error.message}`);
  }

  switch (data.status) {
    case "sent":
      break;
    // A code is already out there in both of these, so the entry form stays up.
    case "cooldown":
      return {
        status: "sent",
        mobile: mobile.value,
        error: `Hold on ${data.retry_after_seconds ?? OTP_RESEND_COOLDOWN_SECONDS} seconds before asking for another code.`,
        retryAfterSeconds: data.retry_after_seconds ?? OTP_RESEND_COOLDOWN_SECONDS,
      };
    case "rate_limited":
      return {
        status: "sent",
        mobile: mobile.value,
        error: "That's a lot of codes for one hour. Try again a little later.",
      };
    case "mobile_taken":
      return fieldError("mobile", "That mobile number is already registered.");
    case "invalid_mobile":
      return fieldError("mobile", "Enter a valid 10-digit Indian mobile number.");
    default:
      throw new Error(`request_phone_verification returned ${data.status}`);
  }

  try {
    await sendVerificationSms(mobile.value, code);
  } catch (cause) {
    if (cause instanceof SmsNotConfiguredError) {
      console.error("[auth] mobile verification blocked: no SMS provider configured");
      return {
        status: "error",
        error: "We can't send SMS yet. Hang tight while we finish setting that up.",
      };
    }
    throw cause;
  }

  return {
    status: "sent",
    mobile: mobile.value,
    notice: `Code sent to ${formatMobile(mobile.value)}.`,
    retryAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS,
  };
}

export async function confirmMobileOtp(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await requireMobileStep();
  const otp = parseOtp(formData.get("otp"));

  if (!otp.ok) {
    return { status: "sent", fieldErrors: { otp: otp.error } };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("verify_phone_otp", { p_profile_id: context.user.id, p_otp: otp.value })
    .single();

  if (error) throw new Error(`verify_phone_otp failed: ${error.message}`);

  switch (data.status) {
    case "verified":
      break;
    case "invalid":
      return {
        status: "sent",
        fieldErrors: {
          otp:
            data.attempts_left && data.attempts_left > 0
              ? `That code isn't right. ${data.attempts_left} ${data.attempts_left === 1 ? "try" : "tries"} left.`
              : "That code isn't right.",
        },
      };
    case "expired":
      return { status: "sent", error: "That code has expired. Ask for a new one." };
    case "too_many_attempts":
      return { status: "sent", error: "Too many wrong codes. Ask for a new one." };
    case "no_code":
      return { status: "idle", error: "Ask for a code first." };
    case "mobile_taken":
      return fieldError("mobile", "That mobile number was just registered by someone else.");
    default:
      throw new Error(`verify_phone_otp returned ${data.status}`);
  }

  const role = context.intendedRole;
  if (role) await ensureRoleRecord(role, context.user.id);

  if (role === "worker") redirect(AUTH_ROUTES.workerCategories);
  if (role === "client") redirect(AUTH_ROUTES.clientHome);

  // No stated intent — the chooser asks rather than guessing.
  redirect(AUTH_ROUTES.signup);
}

// ---------------------------------------------------------------------------
// Role selection and worker categories
// ---------------------------------------------------------------------------

/** Recovery path: a verified account that never picked a side, usually because
 *  signup was interrupted between the email link and the mobile code. */
export async function chooseRole(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await requireContext();
  const requested = formData.get("role");

  if (requested !== "client" && requested !== "worker") {
    return { status: "error", error: "Pick how you want to use Zevi." };
  }

  if (context.step === "verify_email" || context.step === "verify_mobile") {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  await ensureRoleRecord(requested, context.user.id);

  redirect(requested === "worker" ? AUTH_ROUTES.workerCategories : AUTH_ROUTES.clientHome);
}

export async function saveWorkerCategories(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  const context = await requireContext();

  if (context.step === "verify_email" || context.step === "verify_mobile") {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  const selected = formData
    .getAll("categoryId")
    .filter((value): value is string => typeof value === "string");

  if (selected.length === 0) {
    return { status: "error", error: "Pick at least one category." };
  }

  if (selected.length > MAX_WORKER_CATEGORIES) {
    return {
      status: "error",
      error: `Pick up to ${MAX_WORKER_CATEGORIES} categories — the database enforces the same limit.`,
    };
  }

  const supabase = await createClient();

  const { data: categories, error: categoryError } = await supabase
    .from("categories")
    .select("id, slug")
    .eq("status", "active");

  if (categoryError) {
    throw new Error(`Could not load categories: ${categoryError.message}`);
  }

  const selectable = new Set(
    (categories ?? [])
      .filter((category) => !NON_WORKER_CATEGORY_SLUGS.includes(category.slug))
      .map((category) => category.id),
  );

  if (!selected.every((id) => selectable.has(id))) {
    return { status: "error", error: "One of those categories isn't open to workers." };
  }

  await ensureRoleRecord("worker", context.user.id);

  // Replace rather than merge: the form is the complete answer, and the three
  // category limit is a trigger that counts rows, not submissions.
  const { error: clearError } = await supabase
    .from("worker_categories")
    .delete()
    .eq("worker_id", context.user.id);

  if (clearError) {
    throw new Error(`Could not clear existing categories: ${clearError.message}`);
  }

  const { error: insertError } = await supabase
    .from("worker_categories")
    .insert(selected.map((id) => ({ worker_id: context.user.id, category_id: id })));

  if (insertError) {
    throw new Error(`Could not save categories: ${insertError.message}`);
  }

  // The unit the 24-hour approval queue works through (spec §6). It stays a
  // draft until samples are attached and `submit_worker_application()` moves it
  // on — which opens one itself if this ever failed, so a signup interrupted
  // here recovers rather than needing support.
  const { data: application, error: applicationError } = await supabase
    .from("worker_applications")
    .select("id")
    .eq("worker_id", context.user.id)
    .limit(1);

  if (applicationError) {
    throw new Error(`Could not read the worker application: ${applicationError.message}`);
  }

  if (!application || application.length === 0) {
    const { error: draftError } = await supabase
      .from("worker_applications")
      .insert({ worker_id: context.user.id, attempt: 1, status: "draft" });

    if (draftError) {
      throw new Error(`Could not open a worker application: ${draftError.message}`);
    }
  }

  // Samples are the next gate, not the feed: nothing in the feed is reachable
  // until an admin has approved them (spec §6).
  redirect(WORKER_ROUTES.samples);
}
