/**
 * Auth constants.
 *
 * The OTP numbers are mirrors of `auth.*` rows in `platform_settings`, kept
 * here for copy and countdowns. The database is the authority: every limit is
 * enforced inside `request_phone_verification()` and `verify_phone_otp()`, so a
 * stale constant makes a label wrong, never a limit loose.
 */

export const DEFAULT_COUNTRY_CODE = "+91";

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt truncates past 72 bytes; GoTrue hashes with bcrypt. */
export const PASSWORD_MAX_BYTES = 72;

export const FULL_NAME_MIN_LENGTH = 2;
export const FULL_NAME_MAX_LENGTH = 120;

export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** Spec §6: a worker may hold at most three categories. */
export const MAX_WORKER_CATEGORIES = 3;

/**
 * "Other" is where an unclassified client brief lands (spec §5), not a skill
 * anyone signs up to do. It never appears in the worker category picker.
 */
export const NON_WORKER_CATEGORY_SLUGS = ["other"];

/** Carries the address to the "check your inbox" screen without a session. */
export const PENDING_EMAIL_COOKIE = "zevi_pending_email";
export const PENDING_EMAIL_COOKIE_MAX_AGE = 60 * 30;

export const AUTH_ROUTES = {
  login: "/login",
  signup: "/signup",
  signupClient: "/signup/client",
  signupWorker: "/signup/worker",
  workerCategories: "/signup/worker/categories",
  verifyEmail: "/verify/email",
  verifyMobile: "/verify/mobile",
  callback: "/auth/callback",
  clientHome: "/dashboard",
  workerHome: "/worker",
} as const;
