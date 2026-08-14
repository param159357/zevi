/**
 * Input parsers for the job posting boundary.
 *
 * Pure, no I/O. Same contract as the auth parsers: every rule here has a
 * matching CHECK, trigger or `publish_job()` branch in the database, and this
 * layer exists to turn a constraint violation into a sentence someone can act
 * on — not to replace it.
 *
 * A draft is parsed leniently and a publish strictly, because those are two
 * different questions. "Is this worth storing while they type" is not "is this
 * fit to show a worker".
 */

import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MIN_LENGTH,
  MAX_BUDGET_PAISE,
  MIN_BUDGET_PAISE,
  TITLE_MAX_LENGTH,
  TITLE_MIN_LENGTH,
  maxDeadlineDays,
} from "@/lib/constants/jobs";
import { formatPaiseCompact, parseRupeesToPaise } from "@/lib/utils/money";
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

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** What gets stored on an autosave: trimmed, capped, and null when empty. */
export function draftText(input: unknown, maxLength: number): string | null {
  const value = asString(input).slice(0, maxLength).trim();
  return value.length > 0 ? value : null;
}

export function parseJobTitle(input: unknown): Parsed<string> {
  const value = asString(input).replace(/\s+/g, " ").trim();

  if (!value) return fail("Give the job a title.");
  if (value.length < TITLE_MIN_LENGTH) {
    return fail(`That's too short — ${TITLE_MIN_LENGTH} characters at least.`);
  }
  if (value.length > TITLE_MAX_LENGTH) {
    return fail(`Keep the title under ${TITLE_MAX_LENGTH} characters.`);
  }

  return ok(value);
}

export function parseJobDescription(input: unknown): Parsed<string> {
  const value = asString(input).trim();

  if (!value) return fail("Describe what you need done.");
  if (value.length < DESCRIPTION_MIN_LENGTH) {
    return fail(
      `A worker needs more than this to price the job — ${DESCRIPTION_MIN_LENGTH} characters at least.`,
    );
  }
  if (value.length > DESCRIPTION_MAX_LENGTH) {
    return fail(`That's over the ${DESCRIPTION_MAX_LENGTH.toLocaleString("en-IN")} character limit.`);
  }

  return ok(value);
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Lenient: whatever parses as an amount, for storing mid-keystroke. */
export function draftBudgetPaise(input: unknown): number | null {
  const paise = parseRupeesToPaise(input);
  return paise !== null && paise >= 0 ? paise : null;
}

export function parseBudgetPaise(input: unknown): Parsed<number> {
  const raw = asString(input).trim();
  if (!raw) return fail("Set a budget.");

  const paise = parseRupeesToPaise(raw);
  if (paise === null) return fail("Enter an amount in rupees, like 1500.");

  // Spec §5 — the floor. Below it, commission is larger than the job.
  if (paise < MIN_BUDGET_PAISE) {
    return fail(`The minimum budget is ${formatPaiseCompact(MIN_BUDGET_PAISE)}.`);
  }
  // Spec §10 — the value cap for the first three months.
  if (paise > MAX_BUDGET_PAISE) {
    return fail(
      `Jobs are capped at ${formatPaiseCompact(MAX_BUDGET_PAISE)} for now. Write to us for anything larger.`,
    );
  }

  return ok(paise);
}

// ---------------------------------------------------------------------------
// Deadline
//
// The client picks a calendar date; the deadline is the end of that day in
// India, where everyone on the platform is (see parseMobile). Times of day
// would be false precision on a brief.
// ---------------------------------------------------------------------------

const IST_OFFSET_MINUTES = 330;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date in India at a given moment, as `yyyy-mm-dd`. */
export function istDateString(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/** `2026-08-20` → the instant 23:59:59.999 IST that day, which is 18:29:59.999Z. */
export function endOfDayIst(date: string): string {
  return `${date}T18:29:59.999Z`;
}

/** The date part of a stored deadline, back in India's calendar. */
export function deadlineDateFromIso(iso: string | null): string {
  return iso ? istDateString(new Date(iso)) : "";
}

export type DeadlineWindow = {
  /** Earliest selectable date, `yyyy-mm-dd`. */
  minDate: string;
  /** Latest selectable date, `yyyy-mm-dd`. */
  maxDate: string;
  /** The cap this budget bought, in days. */
  capDays: number;
};

/**
 * Spec §5's value-based caps, as a date range a `<input type="date">` can use.
 *
 * The cap is measured from the moment the job goes live, so an open job keeps
 * measuring from the day it was published rather than from today. The last
 * selectable date is one short of the cap because the deadline lands at the end
 * of that day: pick the seventh day and 23:59 on it is past `published_at +
 * 7 days`, which `enforce_job_rules()` rejects.
 */
export function deadlineWindow({
  budgetPaise,
  publishedAt = null,
  now = new Date(),
}: {
  budgetPaise: number;
  publishedAt?: string | null;
  now?: Date;
}): DeadlineWindow {
  const capDays = maxDeadlineDays(budgetPaise);
  const basis = publishedAt ? new Date(publishedAt) : now;
  const today = istDateString(now);

  return {
    // A job that is already live may be edited on its last day; a new one gets
    // tomorrow at the earliest, because "due in four hours" is not a brief.
    minDate: publishedAt ? today : addDays(today, 1),
    maxDate: addDays(istDateString(basis), capDays - 1),
    capDays,
  };
}

export function parseDeadline(
  input: unknown,
  window: DeadlineWindow,
): Parsed<string> {
  const date = asString(input).trim();

  if (!date) return fail("Pick a deadline.");
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return fail("Pick a date from the calendar.");
  }

  if (date < window.minDate) return fail("Pick a date in the future.");
  if (date > window.maxDate) {
    return fail(
      `A job at this budget can run for at most ${window.capDays} days. Raise the budget for longer.`,
    );
  }

  return ok(endOfDayIst(date));
}

/** Lenient: store a well-formed date on autosave, ignore a half-typed one. */
export function draftDeadline(input: unknown): string | null {
  const date = asString(input).trim();
  if (!DATE_PATTERN.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return null;
  }
  return endOfDayIst(date);
}
