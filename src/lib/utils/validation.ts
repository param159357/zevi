/**
 * Input parsers for the auth boundary.
 *
 * Pure, no I/O — these run on form payloads before anything reaches Supabase.
 * Every rule here has a matching constraint in the database (see the `profiles`
 * checks in migration 0002); this layer exists to turn a constraint violation
 * into a sentence someone can act on, not to replace it.
 */

import {
  DEFAULT_COUNTRY_CODE,
  FULL_NAME_MAX_LENGTH,
  FULL_NAME_MIN_LENGTH,
  OTP_LENGTH,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from "@/lib/constants/auth";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function asString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

/** Mirrors the `profiles_email_shape` check. Deliberately loose — the only real
 *  proof an address exists is the confirmation mail. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function parseEmail(input: unknown): Parsed<string> {
  const value = asString(input).trim().toLowerCase();

  if (!value) return fail("Enter your email address.");
  if (value.length > 254) return fail("That email address is too long.");
  if (!EMAIL_PATTERN.test(value)) return fail("Enter a valid email address.");

  return ok(value);
}

/**
 * Indian mobile numbers, normalised to E.164 for storage.
 *
 * Accepts `9876543210`, `09876543210`, `919876543210` and `+91 98765 43210`.
 * Other country codes are refused rather than silently mangled: payouts, KYC
 * and SMS pricing all assume India for now (spec §6), and the day that changes
 * this is the one place that has to know.
 */
export function parseMobile(input: unknown): Parsed<string> {
  const raw = asString(input).trim();
  if (!raw) return fail("Enter your mobile number.");

  const compact = raw.replace(/[\s()\-.]/g, "");

  if (/^(\+91|91|0)?[6-9]\d{9}$/.test(compact)) {
    return ok(`${DEFAULT_COUNTRY_CODE}${compact.slice(-10)}`);
  }

  if (/^\+\d{7,15}$/.test(compact)) {
    return fail("Indian mobile numbers only for now.");
  }

  return fail("Enter a valid 10-digit Indian mobile number.");
}

export function parsePassword(input: unknown): Parsed<string> {
  const value = asString(input);

  if (!value) return fail("Choose a password.");
  if (value.length < PASSWORD_MIN_LENGTH) {
    return fail(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  // bcrypt ignores everything past 72 bytes, so a longer password is not the
  // stronger password it looks like.
  if (new TextEncoder().encode(value).length > PASSWORD_MAX_BYTES) {
    return fail("That password is too long.");
  }

  return ok(value);
}

/** Workers must match their ID and bank account (spec §6), so no nicknames. */
export function parseFullName(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\s+/g, " ").trim();

  if (!value) return fail("Enter your full name.");
  if (value.length < FULL_NAME_MIN_LENGTH) return fail("That name looks too short.");
  if (value.length > FULL_NAME_MAX_LENGTH) return fail("That name is too long.");
  if (!/\p{L}/u.test(value)) return fail("Enter your name as it appears on your ID.");

  return ok(value);
}

export function parseOtp(input: unknown): Parsed<string> {
  const value = asString(input).replace(/[\s-]/g, "");

  if (!value) return fail("Enter the code we sent you.");
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(value)) {
    return fail(`The code is ${OTP_LENGTH} digits.`);
  }

  return ok(value);
}

/**
 * `profiles.signup_ip` is `inet`, and the trigger casts straight to it — an
 * unparseable forwarded header would fail the signup rather than the lookup it
 * was gathered for.
 */
export function parseIpAddress(input: unknown): string | null {
  const value = asString(input).split(",")[0].trim();
  if (!value) return null;

  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-f:]+$/i;

  if (ipv4.test(value)) {
    return value.split(".").every((part) => Number(part) <= 255) ? value : null;
  }

  return ipv6.test(value) && value.includes(":") ? value : null;
}

/** `+919876543210` → `+91 98765 43210`. */
export function formatMobile(e164: string): string {
  const match = /^\+91(\d{5})(\d{5})$/.exec(e164);
  return match ? `+91 ${match[1]} ${match[2]}` : e164;
}

/**
 * A relative path from a `?next=` parameter, or null. Anything absolute or
 * protocol-relative is an open redirect waiting to be used in a phishing mail.
 */
export function parseRedirectPath(input: unknown): string | null {
  const value = asString(input);

  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return null;
  }

  return value;
}
