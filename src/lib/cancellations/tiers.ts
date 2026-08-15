/**
 * The cancellation tiers — spec §5.
 *
 * | When                      | Refund                                       |
 * |---------------------------|----------------------------------------------|
 * | No worker assigned yet    | Full, instant, no fee                        |
 * | ≤30% of deadline elapsed  | Full, minus ₹15                              |
 * | 31–50% elapsed            | 80% client / 20% worker, minus ₹15           |
 * | >50% elapsed              | Admin assesses; client refund capped at 70%  |
 * | After delivery            | No percentage refund — accept, revise, dispute |
 *
 * ---------------------------------------------------------------------------
 * Why this is in TypeScript when the money is in the database
 *
 * The same split `lib/payouts/cycle.ts` makes, for the same reason. The
 * *decision* belongs to `request_job_cancellation()`, which locks the job,
 * reads the frozen `job_financials` row and moves escrow and the ledger in one
 * transaction — a browser cannot be trusted with any of that. But a client has
 * to be shown what they will get back **before** they confirm, and a screen that
 * asks the database to compute a quote it will then recompute anyway is two
 * implementations waiting to disagree. So this module is what the screen quotes
 * and what the tests check against the spec, and the function is what decides.
 *
 * The database is not trusting this: it derives the tier itself from its own
 * `now()` and its own settings. If the two disagree — a clock skew, a stale
 * constant, a client who left the confirmation open for an hour — the function
 * wins and the action reports the tier it actually applied. That is why
 * `applyCancellation` returns the tier alongside the money rather than taking
 * one as an argument.
 *
 * ---------------------------------------------------------------------------
 * "Percent of deadline elapsed", measured from where
 *
 * From **assignment**, not from posting. The deadline is set when the job is
 * posted, but nobody is working against it until someone is picked, and the
 * whole purpose of the middle tier is to pay a worker for time they have already
 * spent. A job posted a fortnight before anyone opted in would otherwise land in
 * the >50% tier on its first day of actual work.
 *
 * The pre-assignment tier covers everything before that moment, so the two
 * together are total: either a worker has started or they have not.
 */

import {
  CANCELLATION_FEE_PAISE,
  EARLY_MAX_ELAPSED_BPS,
  LATE_CLIENT_CAP_BPS,
  MID_MAX_ELAPSED_BPS,
  MID_WORKER_SHARE_BPS,
} from "@/lib/constants/cancellations";
import type { Database } from "@/types/database.types";

export type CancellationTier = Database["public"]["Enums"]["cancellation_tier"];

/**
 * What cancelling this job right now would do.
 *
 * A discriminated union rather than one shape with nullable fields, because the
 * four outcomes carry genuinely different facts: an assessed cancellation has no
 * refund figure yet, and a refused one has no money in it at all. A screen that
 * has to render "₹0.00" to mean "we cannot tell you yet" is a screen that will
 * eventually render it to mean "nothing".
 */
export type CancellationQuote =
  /** Nobody was picked, so nothing was ever charged. Spec §5's first row. */
  | {
      tier: "pre_assignment";
      kind: "immediate";
      elapsedBps: null;
      clientRefundPaise: number;
      workerCompensationPaise: 0;
      feePaise: 0;
    }
  /** Inside the tiers: the rules apply automatically (spec §11, layer 1). */
  | {
      tier: "early" | "mid";
      kind: "immediate";
      elapsedBps: number;
      clientRefundPaise: number;
      workerCompensationPaise: number;
      feePaise: number;
    }
  /** Past half the window: a person decides, and cannot exceed the cap. */
  | {
      tier: "late";
      kind: "assessed";
      elapsedBps: number;
      maxClientRefundPaise: number;
      clientRefundCapBps: number;
    }
  /** Spec §5's last row: "no percentage refund — accept, revise, or dispute". */
  | {
      tier: "post_delivery";
      kind: "refused";
      elapsedBps: number | null;
    };

export type JobTiming = {
  /** Null until someone is picked. Its presence is what separates the first
   *  tier from the rest. */
  assignedAt: Date | null;
  /** `jobs_publishable` requires one on every status past 'draft', so this is
   *  only null on a draft — which is always pre-assignment anyway. */
  deadlineAt: Date | null;
  /** Whether anything has been delivered on this job, in any attempt. The last
   *  row of the table is about *delivery*, not about the clock: a worker who
   *  sent the work on day two has delivered, however little of the window ran. */
  hasDelivery: boolean;
};

/**
 * How far into the worker's window we are, in basis points, clamped to the ends.
 *
 * Returns null before assignment, where the question has no meaning. A window
 * that is zero or negative — a deadline at or before the assignment, which
 * `jobs_deadline_after_publish` makes hard but not impossible — reads as fully
 * elapsed, so the safe tier applies and a person looks at it.
 *
 * **Floored, not rounded.** Basis points are the resolution of the decision, so
 * a boundary is only crossed once a whole one has passed — a hundredth of a
 * percent, which on a ten-day window is about a minute and a half. Rounding
 * would move a client into the *worse* tier while less than a full unit had
 * elapsed; flooring never overstates the time spent, so the quantisation always
 * falls on the side of the person being charged for it.
 */
export function elapsedBps(timing: JobTiming, now: Date = new Date()): number | null {
  if (!timing.assignedAt || !timing.deadlineAt) return null;

  const window = timing.deadlineAt.getTime() - timing.assignedAt.getTime();
  if (window <= 0) return 10_000;

  const spent = now.getTime() - timing.assignedAt.getTime();

  return Math.min(Math.max(Math.floor((spent * 10_000) / window), 0), 10_000);
}

/** The tier alone, without the arithmetic. Exported for the screens that only
 *  need to know whether the button should say "cancel" or "ask us to look". */
export function cancellationTier(timing: JobTiming, now: Date = new Date()): CancellationTier {
  // Deliberately first. Delivery ends the cancellation path whatever the clock
  // says, and a client who is looking at delivered work has three other doors.
  if (timing.hasDelivery) return "post_delivery";
  if (!timing.assignedAt) return "pre_assignment";

  const elapsed = elapsedBps(timing, now);
  if (elapsed === null) return "late";

  if (elapsed <= EARLY_MAX_ELAPSED_BPS) return "early";
  if (elapsed <= MID_MAX_ELAPSED_BPS) return "mid";
  return "late";
}

/**
 * The whole quote, money included.
 *
 * Two rounding rules, and both exist so nobody can end up owed a negative
 * number:
 *
 *   * the worker's 20% is floored, so the remainder falls to the client;
 *   * the fee is never more than what is left after the worker's share, so a
 *     job at the ₹149 minimum cannot produce a refund below zero.
 *
 * Every figure is a division of the **budget**, which is what escrow holds. The
 * client's commission and GST were recognised as revenue when the card was
 * charged (spec §8's gross is realised across two moments) and whether a
 * cancelling client gets those back is a question spec §8 and §14 do not answer
 * — so this does not answer it either. Same position `resolve_dispute()` takes.
 */
export function quoteCancellation({
  budgetPaise,
  timing,
  now = new Date(),
}: {
  budgetPaise: number;
  timing: JobTiming;
  now?: Date;
}): CancellationQuote {
  const tier = cancellationTier(timing, now);
  const elapsed = elapsedBps(timing, now);

  if (tier === "post_delivery") {
    return { tier, kind: "refused", elapsedBps: elapsed };
  }

  if (tier === "pre_assignment") {
    // Payment happens at selection and nowhere else (spec §4, step 5), so an
    // unassigned job has never been charged for. "Full, instant, no fee" is
    // therefore a statement about a card that was never touched — the refund is
    // zero because there is nothing to send back, not because anything is kept.
    return {
      tier,
      kind: "immediate",
      elapsedBps: null,
      clientRefundPaise: 0,
      workerCompensationPaise: 0,
      feePaise: 0,
    };
  }

  if (tier === "late") {
    return {
      tier,
      kind: "assessed",
      elapsedBps: elapsed ?? 10_000,
      maxClientRefundPaise: Math.floor((budgetPaise * LATE_CLIENT_CAP_BPS) / 10_000),
      clientRefundCapBps: LATE_CLIENT_CAP_BPS,
    };
  }

  const workerCompensationPaise =
    tier === "mid" ? Math.floor((budgetPaise * MID_WORKER_SHARE_BPS) / 10_000) : 0;

  const feePaise = Math.min(
    CANCELLATION_FEE_PAISE,
    Math.max(budgetPaise - workerCompensationPaise, 0),
  );

  return {
    tier,
    kind: "immediate",
    elapsedBps: elapsed ?? 0,
    clientRefundPaise: budgetPaise - workerCompensationPaise - feePaise,
    workerCompensationPaise,
    feePaise,
  };
}
