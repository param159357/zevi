/**
 * Cancellation constants — spec §5's tier table and spec §8's flat fee.
 *
 * Same rule as the job, delivery and payout constants: every number here has its
 * authority in the database. The boundaries are `platform_settings` rows read by
 * `request_job_cancellation()` in migration 0036; the ₹15 is a `fee_schedule`
 * row, versioned like every other rate so the day it moves the old jobs stay
 * explicable. These copies exist so the screen can quote the refund *before* a
 * client commits to it — cancelling is irreversible and the number they will get
 * back is the whole of the decision.
 *
 * A stale constant here makes a quote wrong, which is bad enough to keep them in
 * step; it never makes a refund wrong, because the function recomputes every
 * figure from the frozen `job_financials` row and its own reading of the clock.
 */

/**
 * Spec §5: "Full, minus ₹15" and "80% client / 20% worker, minus ₹15".
 * Spec §8 calls it the actual gateway cost on a job above ₹2,000, and adds the
 * rule that gives it its shape: **never charged when no worker opted in — that
 * is Zevi's failure, not the client's.** The pre-assignment tier carries no fee
 * for exactly that reason.
 *
 * Mirrors `fee_schedule.amount_paise` where `code = 'cancellation'`.
 */
export const CANCELLATION_FEE_PAISE = 1_500;

/**
 * The two boundaries in spec §5's table, as basis points of the worker's
 * window. `cancellation.early_max_bps` and `cancellation.mid_max_bps`.
 *
 * "≤30% of deadline elapsed" is the early tier; "31–50%" is the middle one;
 * anything past half is assessed by a person. Expressed as ≤30% and ≤50% rather
 * than as 30/31 and 50/51, because elapsed time is continuous and the spec's
 * integer percentages are a way of writing two thresholds, not four.
 */
export const EARLY_MAX_ELAPSED_BPS = 3_000;
export const MID_MAX_ELAPSED_BPS = 5_000;

/** Spec §5: the middle tier is "80% client / 20% worker". The worker's 20% is
 *  the stored number because it is the one that becomes an earning. */
export const MID_WORKER_SHARE_BPS = 2_000;

/**
 * Spec §5: ">50% elapsed → admin assesses; client refund **capped at 70%**."
 *
 * A cap that only lives in a sentence is a cap an admin can type past at four in
 * the afternoon, so this one is carried onto the dispute row as
 * `client_refund_cap_bps` and `resolve_dispute()` refuses any outcome that gives
 * the client more. The same discipline as KYC's no-override block: the rule is
 * code, not something a reviewer is trusted to remember.
 */
export const LATE_CLIENT_CAP_BPS = 7_000;
