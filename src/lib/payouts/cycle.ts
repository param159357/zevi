/**
 * The twice-weekly payout calendar — spec §6 "Payouts".
 *
 *   Cycle closes Wednesday midnight → paid Friday
 *   Cycle closes Sunday    midnight → paid Tuesday
 *
 * Resolved into instants, and this is the whole of the rule:
 *
 *   cutoff  Thursday 00:00 IST  → pays Friday
 *   cutoff  Monday   00:00 IST  → pays Tuesday
 *
 * See `CYCLE_CLOSE_DAYS` for why "Wednesday midnight" is the midnight that *ends*
 * Wednesday. The two cycles are deliberately unequal — Thursday to Monday is
 * four days, Monday to Thursday is three — because twice a week on fixed
 * weekdays cannot be evenly spaced. Nothing depends on their being equal.
 *
 * ---------------------------------------------------------------------------
 * Why this is in TypeScript and not in SQL
 *
 * The rest of this codebase puts money decisions in the database, and the batch
 * builder in migration 0031 is no exception — it selects the earnings, writes
 * the payouts and moves the ledger, all in one transaction nothing else can
 * interleave with. But the *calendar* is a different kind of thing: it is a pure
 * function of the clock, it has no rows to lock, and two screens need it before
 * any batch exists ("your next payout is Friday"). Putting it here means one
 * implementation, reachable by the test runner, rather than one in a Server
 * Component and one in plpgsql drifting apart.
 *
 * What the database keeps is the *invariant*: `build_payout_batch()` refuses any
 * cutoff that is not midnight IST on a Thursday or a Monday, and refuses one in
 * the future. So a caller that computed the wrong instant — or a compromised
 * cron trying to pay everyone today — cannot make an early payout representable.
 * That is a shape check on this module's output, not a second copy of it.
 */

import {
  CUTOFF_WEEKDAYS,
  IST_OFFSET_MINUTES,
  PAY_RUN_HOUR_IST,
} from "@/lib/constants/payouts";

const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

/** One cycle, from the previous cutoff to the day the money is sent. */
export type PayoutCycle = {
  /** The previous cutoff. Informational — the batch selects everything mature,
   *  not everything mature *within* this window. See `closesLabel`. */
  cycleStartAt: Date;
  /** Thursday or Monday, 00:00 IST. Everything mature by this instant is in. */
  cutoffAt: Date;
  /** The following day at `PAY_RUN_HOUR_IST`. */
  scheduledPayAt: Date;
  /** The day the cycle is described as closing on: "Wednesday" or "Sunday". */
  closesLabel: string;
  /** "Friday" or "Tuesday". */
  paysLabel: string;
};

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** IST wall-clock fields for an instant. */
function istParts(instant: Date): { year: number; month: number; day: number; weekday: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * An IST wall-clock moment back to the instant it names. `Date.UTC` normalises
 * an out-of-range day, so `day + 4` across a month or year end is correct
 * without any calendar arithmetic here.
 */
function fromIst(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month, day, hour) - IST_OFFSET_MS);
}

/** IST weekday of an instant. 0 = Sunday. */
export function istWeekday(instant: Date): number {
  return istParts(instant).weekday;
}

/**
 * Is this instant a real cycle cutoff — midnight IST on a Thursday or a Monday?
 * The same question `build_payout_batch()` asks in SQL before it will build
 * anything.
 */
export function isCutoffInstant(instant: Date): boolean {
  const parts = istParts(instant);
  const midnight = fromIst(parts.year, parts.month, parts.day);

  return (
    midnight.getTime() === instant.getTime() &&
    (CUTOFF_WEEKDAYS as readonly number[]).includes(parts.weekday)
  );
}

/**
 * The first cutoff at or after `instant` — the cycle that will pay work which
 * becomes payable then.
 *
 * "At or after" is the boundary that matters: an earning maturing at exactly
 * Thursday 00:00 IST makes that cycle, because the batch selects
 * `eligible_at <= cutoff`. One second later and it waits for Monday.
 */
export function cutoffOnOrAfter(instant: Date): Date {
  const parts = istParts(instant);

  // At most a week away, and the loop is over IST midnights so it never has to
  // reason about how long a day is.
  for (let add = 0; add <= 7; add += 1) {
    const candidate = fromIst(parts.year, parts.month, parts.day + add);

    if (candidate.getTime() >= instant.getTime() && isCutoffInstant(candidate)) {
      return candidate;
    }
  }

  // Unreachable: two cutoffs a week means one is never more than four days off.
  throw new Error(`no payout cutoff found within a week of ${instant.toISOString()}`);
}

/**
 * The most recent cutoff at or before `instant` — the cycle the cron should be
 * building now.
 */
export function cutoffOnOrBefore(instant: Date): Date {
  const parts = istParts(instant);

  for (let subtract = 0; subtract <= 7; subtract += 1) {
    const candidate = fromIst(parts.year, parts.month, parts.day - subtract);

    if (candidate.getTime() <= instant.getTime() && isCutoffInstant(candidate)) {
      return candidate;
    }
  }

  throw new Error(`no payout cutoff found within a week before ${instant.toISOString()}`);
}

/**
 * The full cycle around a cutoff. Throws on an instant that is not a cutoff,
 * rather than rounding to a nearby one — every caller here has either computed
 * it with `cutoffOnOrAfter`/`cutoffOnOrBefore` or read it back off a batch row,
 * and a "close enough" cutoff is a payout on the wrong day.
 */
export function cycleForCutoff(cutoffAt: Date): PayoutCycle {
  if (!isCutoffInstant(cutoffAt)) {
    throw new Error(
      `${cutoffAt.toISOString()} is not a payout cutoff: cycles close at midnight IST on Wednesday and Sunday`,
    );
  }

  const parts = istParts(cutoffAt);

  return {
    cycleStartAt: cutoffOnOrBefore(new Date(cutoffAt.getTime() - 1)),
    cutoffAt,
    scheduledPayAt: fromIst(parts.year, parts.month, parts.day + 1, PAY_RUN_HOUR_IST),
    // The cutoff instant is midnight *starting* Thursday, so the day that just
    // closed is the one before it, and the pay day the one after.
    closesLabel: WEEKDAY_NAMES[(parts.weekday + 6) % 7],
    paysLabel: WEEKDAY_NAMES[(parts.weekday + 1) % 7],
  };
}

/** The cycle that pays work becoming payable at `instant`. */
export function cycleFor(instant: Date): PayoutCycle {
  return cycleForCutoff(cutoffOnOrAfter(instant));
}

/** The cycle the cron should be building at `now` — the one that has closed. */
export function closedCycleAt(now: Date): PayoutCycle {
  return cycleForCutoff(cutoffOnOrBefore(now));
}
