/**
 * The KYC form, parsed at the boundary. Pure, no I/O.
 *
 * Spec §6 asks for four things — full name, PAN, bank+IFSC or UPI, date of birth
 * — and every rule below has its authority elsewhere: a CHECK on `worker_kyc` or
 * `payout_methods`, the `enforce_kyc_adult()` trigger, or Razorpay refusing the
 * account. This layer exists so a worker learns about a typed digit before a
 * penny drop is spent on it, and so the message they read is a sentence rather
 * than a constraint name.
 *
 * One thing here is more than validation: `lastFour` and `maskUpi` decide what
 * is kept. The full account number and the full PAN go to Razorpay and are never
 * written down — see `lib/kyc/hash.ts` for the other half of that.
 */

import {
  ACCOUNT_NUMBER_PATTERN,
  IFSC_PATTERN,
  LEGAL_NAME_MAX_LENGTH,
  LEGAL_NAME_MIN_LENGTH,
  MAX_AGE_YEARS,
  MIN_AGE_YEARS,
  PAN_PATTERN,
  UPI_PATTERN,
} from "@/lib/constants/kyc";
import type { Parsed } from "@/lib/utils/validation";

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function fail<T>(error: string): Parsed<T> {
  return { ok: false, error };
}

function asString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

/**
 * The name the bank has, which spec §6 requires to match the ID. Control
 * characters go before the length is judged so a padded field cannot pass a
 * minimum it does not meet.
 */
export function parseLegalName(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();

  if (!value) return fail("Enter your name exactly as your bank has it.");
  if (value.length < LEGAL_NAME_MIN_LENGTH) return fail("That name looks too short.");
  if (value.length > LEGAL_NAME_MAX_LENGTH) return fail("That name is too long.");
  if (!/\p{L}/u.test(value)) return fail("Enter your name as it appears on your ID.");

  return ok(value);
}

/**
 * A PAN, uppercased. Spaces come out because people read them off a card in
 * groups; nothing else is repaired, because a PAN with a repaired character is a
 * different PAN.
 */
export function parsePan(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\s/g, "").toUpperCase();

  if (!value) return fail("Enter your PAN.");
  if (!PAN_PATTERN.test(value)) {
    return fail("A PAN is ten characters — five letters, four digits, one letter.");
  }

  return ok(value);
}

/**
 * Date of birth as `YYYY-MM-DD`, which is what `<input type="date">` submits and
 * what Postgres takes.
 *
 * Parsed as UTC and compared against a UTC "today". Everyone on the platform is
 * in IST, five and a half hours ahead, so this can only ever be conservative
 * about an 18th birthday by part of a day — and `enforce_kyc_adult()` is the
 * check that actually refuses, using the database's own clock.
 */
export function parseDateOfBirth(input: unknown, now: Date = new Date()): Parsed<string> {
  const value = asString(input).trim();

  if (!value) return fail("Enter your date of birth.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail("Use the date picker.");

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return fail("That isn't a real date.");

  // Round-trips only if the day exists — 31 February parses to 3 March.
  if (parsed.toISOString().slice(0, 10) !== value) return fail("That isn't a real date.");

  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  if (parsed.getTime() > today.getTime()) return fail("That date is in the future.");

  const eighteenth = new Date(parsed.getTime());
  eighteenth.setUTCFullYear(eighteenth.getUTCFullYear() + MIN_AGE_YEARS);

  if (eighteenth.getTime() > today.getTime()) {
    return fail(`You have to be ${MIN_AGE_YEARS} to be paid through Zevi.`);
  }

  const oldest = new Date(today.getTime());
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_AGE_YEARS);

  if (parsed.getTime() < oldest.getTime()) return fail("Check the year on that.");

  return ok(value);
}

/** Four letters, a zero, six alphanumerics — the CHECK on `payout_methods.ifsc`
 *  in the database, and the same rule at the bank. */
export function parseIfsc(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\s/g, "").toUpperCase();

  if (!value) return fail("Enter your branch IFSC.");
  if (!IFSC_PATTERN.test(value)) {
    return fail("An IFSC is eleven characters, like HDFC0000053.");
  }

  return ok(value);
}

export function parseAccountNumber(input: unknown): Parsed<string> {
  const value = asString(input).replace(/[\s-]/g, "");

  if (!value) return fail("Enter your account number.");
  if (!ACCOUNT_NUMBER_PATTERN.test(value)) {
    return fail("An account number is 6 to 18 digits, and digits only.");
  }

  return ok(value);
}

/** A UPI id, lowercased — handles are case-insensitive and every PSP stores
 *  them folded, so two spellings of one handle must not become two rows. */
export function parseUpiId(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\s/g, "").toLowerCase();

  if (!value) return fail("Enter your UPI ID.");
  if (!UPI_PATTERN.test(value)) return fail("A UPI ID looks like name@bank.");

  return ok(value);
}

/** The only part of an account number that is stored. Matches the CHECK on
 *  `payout_methods.account_last4`. */
export function lastFour(digits: string): string {
  return digits.slice(-4);
}

/** `rajesh.kumar@okhdfcbank` → `raj•••@okhdfcbank`. Enough for a worker to
 *  recognise their own handle, not enough for anyone else to send to it. */
export function maskUpi(vpa: string): string {
  const at = vpa.lastIndexOf("@");
  if (at <= 0) return vpa;

  const local = vpa.slice(0, at);
  const suffix = vpa.slice(at);
  const shown = local.slice(0, Math.min(3, Math.max(1, local.length - 1)));

  return `${shown}${"•".repeat(3)}${suffix}`;
}

/** `HDFC0000053` + `4321` → `HDFC ••4321`. The label on the earnings screen,
 *  and on `payout_methods.label`. */
export function bankLabel(ifsc: string, last4: string): string {
  return `${ifsc.slice(0, 4)} ••${last4}`;
}
