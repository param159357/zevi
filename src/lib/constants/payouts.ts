/**
 * Payout constants — spec §6 "Payouts" and "Earnings".
 *
 * Same rule as the delivery and job constants: every number here has its
 * authority in the database — a `platform_settings` row read by migration 0031,
 * or a CHECK. These copies let a label quote the rule without a round trip. A
 * stale constant makes a sentence wrong, never a payout early.
 */

/**
 * India Standard Time, as a fixed offset.
 *
 * IST is UTC+5:30 and has had no daylight saving since 1945, which is what makes
 * a fixed offset honest here rather than a shortcut — the cycle calendar in
 * `lib/payouts/cycle.ts` converts both ways, and an inverse of `Intl` would be a
 * search loop for a rule that has one answer. Postgres does the same conversion
 * with `at time zone 'Asia/Kolkata'`, which *is* DST-aware; they agree because
 * the zone has no transitions to disagree about.
 */
export const IST_OFFSET_MINUTES = 330;

/**
 * The two days a cycle closes at the end of, as JavaScript weekday numbers in
 * IST (0 = Sunday). Spec §6: "Cycle closes Wednesday midnight → paid Friday.
 * Closes Sunday midnight → paid Tuesday."
 *
 * Read this carefully, because it is the one ambiguous sentence in the spec and
 * everything else follows from how it is resolved: **"Wednesday midnight" is the
 * midnight that ends Wednesday**, so the cutoff instant is Thursday 00:00 IST
 * and work accepted during Wednesday is in Friday's run. The other reading —
 * midnight *starting* Wednesday — would mean nothing that happened on Wednesday
 * counted toward the cycle that closes on Wednesday, which is not what a cycle
 * closing on a day means.
 *
 * So the cutoff instants are Thursday 00:00 and Monday 00:00 IST, and each pays
 * out the following day. `cutoffDayFor` below is the inverse used for labels.
 */
export const CYCLE_CLOSE_DAYS = [3, 0] as const; // Wednesday, Sunday

/** The weekday of the cutoff *instant* — the day after the day that closes. */
export const CUTOFF_WEEKDAYS = [4, 1] as const; // Thursday 00:00, Monday 00:00

/**
 * `platform_settings`: payout.pay_run_hour_ist. The hour on the pay day the
 * batch is actually disbursed at. Migration 0031 stamps `scheduled_pay_at` from
 * this and stores it; nothing re-derives it, so a change here never moves a date
 * a worker was already shown.
 */
export const PAY_RUN_HOUR_IST = 11;

/**
 * `platform_settings`: payout.eligibility_hours. Spec §6: acceptance "plus 48
 * hours" before the cutoff. Stamped onto `worker_earnings.eligible_at` by
 * `accept_job_delivery()` at the moment of acceptance (migration 0030) — this
 * copy is for the sentence on the dashboard, not for the decision.
 */
export const ELIGIBILITY_HOURS = 48;

/**
 * `platform_settings`: payout.new_client_hold_days and
 * payout.new_client_job_threshold. Spec §6: "worker payout held 14 days for a
 * new client's first 3 jobs (chargeback protection)."
 *
 * The hold is about the *client's* history, not the worker's — a worker's first
 * job for their fourth client is not held, and their tenth job for a brand new
 * client is. `accept_job_delivery()` counts `client_profiles.jobs_completed` and
 * stamps `hold_until`; nothing here decides it.
 */
export const NEW_CLIENT_HOLD_DAYS = 14;
export const NEW_CLIENT_JOB_THRESHOLD = 3;

/**
 * How many workers one batch build will pay in a single run. Well above what a
 * platform doing 200 jobs a month produces in a half-week, and bounded so a
 * backlog after an outage drains across runs rather than in one request that
 * times out with half a batch written.
 *
 * Hitting it is not a lost payout: `build_payout_batch()` leaves the batch
 * `open` rather than `closed` when it stops at the cap, and the next run carries
 * on filling the same batch.
 */
export const PAYOUT_BATCH_WORKER_LIMIT = 500;
