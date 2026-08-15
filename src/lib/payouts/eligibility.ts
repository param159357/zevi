/**
 * When an earning becomes payable, and which run pays it — spec §6 "Payouts".
 *
 *   Eligibility: client acceptance (or auto-accept) **plus 48 hours** before the
 *   cycle cutoff. Anything short rolls forward.
 *
 *   New client exception: worker payout held **14 days** for a new client's
 *   first 3 jobs (chargeback protection).
 *
 * Both of those are already *stamped on the row* by `accept_job_delivery()` at
 * the moment of acceptance (migration 0030): `eligible_at` is acceptance plus 48
 * hours, and `hold_until` is set — with a reason — only when the client had
 * fewer than three completed jobs. Nothing here recomputes either, and that is
 * deliberate: a worker told "Friday" must be paid Friday even if the settings
 * move on Thursday. This module reads those two stamps and answers the only
 * question left, which is *which cycle*.
 *
 * ---------------------------------------------------------------------------
 * The correspondence with the batch builder
 *
 * `build_payout_batch()` in migration 0031 selects:
 *
 *     status = 'confirmed' and payout_id is null
 *     and eligible_at is not null and eligible_at <= cutoff
 *     and (hold_until is null or hold_until <= cutoff)
 *     and net_paise > 0
 *
 * `isPayableAtCutoff` below is that predicate, with one difference that is not a
 * difference: it also accepts `on_hold`. The builder never sees an `on_hold` row
 * it should have taken, because it calls `release_matured_earning_holds()` first
 * — so by the time it selects, anything whose hold has expired is already
 * `confirmed`. This module has no such step, and is read by a dashboard that
 * must be able to say "your held earning pays on Friday" *before* the release
 * runs. The `hold_until <= cutoff` test is what actually decides it in both
 * places, which is why the status difference changes no answer.
 *
 * The tests in `eligibility.test.ts` are the specification of that agreement.
 */

import { type PayoutCycle, cycleFor } from "@/lib/payouts/cycle";
import type { Database } from "@/types/database.types";

export type EarningStatus = Database["public"]["Enums"]["earning_status"];

/**
 * The three columns that decide when money moves, and nothing else. Deliberately
 * a structural type rather than the whole row: everything that can delay a
 * payout is one of these, and a caller that has to supply a fourth field is a
 * caller working around the rule.
 */
export type EarningTiming = {
  status: EarningStatus;
  /** Acceptance + 48 hours. Null only on a `pending` earning. */
  eligibleAt: string | Date | null;
  /** The new client's 14-day chargeback hold, or null. */
  holdUntil: string | Date | null;
};

/**
 * Statuses money can still come out of.
 *
 *   confirmed  matured, or a hold that has been released
 *   on_hold    the new-client window, which expires on its own
 *
 * Everything else is terminal or contested. `frozen` is the one worth naming: a
 * dispute or a chargeback investigation, and paying out of it would settle an
 * argument in one party's favour by default. `pending` has no `eligible_at` yet;
 * `in_payout`, `paid`, `reversed` and `forfeited` have already been decided.
 */
const PAYABLE_STATUSES: readonly EarningStatus[] = ["confirmed", "on_hold"];

function asDate(value: string | Date | null): Date | null {
  if (value === null) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The instant an earning becomes payable — the later of its 48-hour maturity and
 * its hold — or null when no cycle will ever pay it as it stands.
 *
 * The two delays are independent and both must have passed, so this is a max and
 * not a sum. In practice the hold dominates whenever it exists (14 days against
 * 48 hours), but nothing here assumes that: the settings behind both are
 * configurable, and a `max` stays right if they cross.
 */
export function payableFrom(earning: EarningTiming): Date | null {
  if (!PAYABLE_STATUSES.includes(earning.status)) return null;

  const eligibleAt = asDate(earning.eligibleAt);

  // No maturity stamp means acceptance never happened. Nothing to pay.
  if (eligibleAt === null) return null;

  const holdUntil = asDate(earning.holdUntil);

  if (holdUntil !== null && holdUntil.getTime() > eligibleAt.getTime()) {
    return holdUntil;
  }

  return eligibleAt;
}

/**
 * Would this earning be picked up by the batch closing at `cutoffAt`?
 *
 * Inclusive at the boundary, matching the builder's `<=`: an earning maturing at
 * exactly the cutoff instant is in that cycle. The alternative loses a worker two
 * or three days over a rounding convention.
 */
export function isPayableAtCutoff(earning: EarningTiming, cutoffAt: Date): boolean {
  const from = payableFrom(earning);

  return from !== null && from.getTime() <= cutoffAt.getTime();
}

/**
 * Which run pays this earning, on the assumption nothing changes — the first
 * cycle whose cutoff is at or after the moment it becomes payable. Null when no
 * cycle will: a frozen earning, or one already in a batch.
 *
 * This is the "anything short rolls forward" half of the spec, and it needs no
 * special case to be. An earning that misses Thursday's cutoff is not marked or
 * moved; the next cutoff simply also has it, because the builder selects
 * everything mature rather than everything mature *since* the last run. A cron
 * that fails for a week pays late, never short.
 */
export function payoutRunFor(earning: EarningTiming): PayoutCycle | null {
  const from = payableFrom(earning);

  return from === null ? null : cycleFor(from);
}
