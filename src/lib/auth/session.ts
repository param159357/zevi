/**
 * Who is signed in, how far through signup they are, and where they belong.
 *
 * Server-only. Every guard here is a convenience for putting a person on the
 * right screen — it is not the access boundary. That is RLS, plus the
 * re-checks inside each Server Action.
 */

import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";

import { AUTH_ROUTES } from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.types";

export type AccountRole = "client" | "worker";

/**
 * Spec §5 and §6: email and mobile are both compulsory and both verified. The
 * steps run in that order, then the account picks up its role record.
 */
export type OnboardingStep =
  | "verify_email"
  | "verify_mobile"
  | "choose_role"
  | "complete";

type ProfileColumns =
  | "id"
  | "email"
  | "email_verified_at"
  | "mobile"
  | "mobile_verified_at"
  | "full_name"
  | "display_name"
  | "status"
  | "status_reason"
  | "suspended_until"
  | "is_client"
  | "is_worker";

export type AuthProfile = Pick<
  Database["public"]["Tables"]["profiles"]["Row"],
  ProfileColumns
>;

const PROFILE_SELECT =
  "id, email, email_verified_at, mobile, mobile_verified_at, full_name, display_name, status, status_reason, suspended_until, is_client, is_worker";

export type AuthContext = {
  user: User;
  profile: AuthProfile;
  /** What they said they were signing up as. Routing only — never authorisation. */
  intendedRole: AccountRole | null;
  /** Collected at signup, held in auth metadata until an OTP proves it. */
  pendingMobile: string | null;
  step: OnboardingStep;
  /** Suspended or banned: signed in, but not allowed into the product. */
  isBlocked: boolean;
};

function metadataString(user: User, key: string): string | null {
  const raw = (user.user_metadata as Record<string, unknown> | undefined)?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Routing intent captured at signup. Users can edit their own metadata, so
 *  this decides which screen comes next and nothing else. */
export function readIntendedRole(user: User): AccountRole | null {
  const raw = metadataString(user, "intended_role");
  return raw === "client" || raw === "worker" ? raw : null;
}

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** The same profile columns every guard reads, for callers that already hold a
 *  client — a Server Action that has just signed someone in, say. */
export async function loadProfile(
  supabase: ServerSupabaseClient,
  userId: string,
): Promise<AuthProfile> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", userId)
    .maybeSingle<AuthProfile>();

  if (error) throw new Error(`Could not load profile ${userId}: ${error.message}`);
  if (!data) {
    throw new Error(
      `Signed-in user ${userId} has no profiles row. Check the on_auth_user_created trigger.`,
    );
  }

  return data;
}

export function resolveStep(user: User, profile: AuthProfile): OnboardingStep {
  if (!user.email_confirmed_at && !profile.email_verified_at) return "verify_email";
  if (!profile.mobile_verified_at) return "verify_mobile";
  if (!profile.is_client && !profile.is_worker) return "choose_role";
  return "complete";
}

export function isBlockedProfile(profile: AuthProfile): boolean {
  if (profile.status === "banned" || profile.status === "suspended") return true;

  return (
    profile.suspended_until !== null &&
    new Date(profile.suspended_until).getTime() > Date.now()
  );
}

/** The screen this account should be looking at right now. */
export function destinationFor(
  step: OnboardingStep,
  profile: AuthProfile,
  intendedRole: AccountRole | null,
): string {
  switch (step) {
    case "verify_email":
      return AUTH_ROUTES.verifyEmail;
    case "verify_mobile":
      return AUTH_ROUTES.verifyMobile;
    case "choose_role":
      return AUTH_ROUTES.signup;
    case "complete": {
      if (intendedRole === "worker" && profile.is_worker) return AUTH_ROUTES.workerHome;
      if (intendedRole === "client" && profile.is_client) return AUTH_ROUTES.clientHome;
      return profile.is_client ? AUTH_ROUTES.clientHome : AUTH_ROUTES.workerHome;
    }
  }
}

/**
 * Cached for the lifetime of one request: a layout, its page and any nested
 * guard all ask the same question, and each miss is a round trip to Supabase.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // The signup trigger creates the profile alongside the auth user, so
  // loadProfile throwing here means that trigger is broken — which is worth a
  // loud failure rather than a redirect loop.
  const profile = await loadProfile(supabase, user.id);
  const intendedRole = readIntendedRole(user);

  return {
    user,
    profile,
    intendedRole,
    pendingMobile: metadataString(user, "pending_mobile"),
    step: resolveStep(user, profile),
    isBlocked: isBlockedProfile(profile),
  };
});

export async function requireUser(): Promise<AuthContext> {
  const context = await getAuthContext();
  if (!context) redirect(AUTH_ROUTES.login);
  return context;
}

/**
 * For the verification screens: a signed-in account that has already cleared
 * this step has no business here.
 */
export async function requireStep(step: OnboardingStep): Promise<AuthContext> {
  const context = await requireUser();

  if (context.step !== step) {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  return context;
}

/** For the `(client)` and `(worker)` layouts. */
export async function requireRole(role: AccountRole): Promise<AuthContext> {
  const context = await requireUser();

  if (context.isBlocked) redirect(`${AUTH_ROUTES.login}?notice=blocked`);

  const hasRole = role === "client" ? context.profile.is_client : context.profile.is_worker;

  if (context.step !== "complete" || !hasRole) {
    redirect(destinationFor(context.step, context.profile, context.intendedRole));
  }

  return context;
}

/**
 * For `/login` and the signup forms. A blocked account is left where it is —
 * bouncing it to a product page that bounces it straight back is a redirect
 * loop, and it needs to see why it cannot get in.
 */
export async function redirectSignedInAway(): Promise<void> {
  const context = await getAuthContext();
  if (!context || context.isBlocked) return;

  redirect(destinationFor(context.step, context.profile, context.intendedRole));
}
