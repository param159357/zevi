/**
 * Feed and opt-in constants.
 *
 * Same rule as the job and worker constants: every number here has its
 * authority in the database — a CHECK on `job_opt_ins`, the
 * `sync_opt_in_counters()` trigger, or a `platform_settings` row. These copies
 * let a form validate before a round trip and let a label quote the rule. A
 * stale constant makes a message wrong; it never makes a limit loose.
 *
 * The two tunables are read from `platform_settings` at request time (both are
 * `is_public`, so the worker's own client can see them) with the constants
 * below as the fallback — the same contract `setting_int()` gives the triggers.
 */

/** `matching.max_active_opt_ins`. Spec §6. `worker_state.opt_in_limit_override`
 *  beats it for one worker, which is why the cap is loaded, not assumed. */
export const MAX_ACTIVE_OPT_INS = 5;
export const MAX_ACTIVE_OPT_INS_SETTING = "matching.max_active_opt_ins";

/** `matching.dwell_seconds`, and the `job_opt_ins_dwell` CHECK. Spec §6: the
 *  button does not activate until the worker has had the brief open this long. */
export const DWELL_SECONDS = 20;
export const DWELL_SECONDS_SETTING = "matching.dwell_seconds";

// ---------------------------------------------------------------------------
// The three short fields (spec §6)
//
// Mirrors the `char_length` checks on job_opt_ins in migration 0007.
// ---------------------------------------------------------------------------

export const SOFTWARE_MIN_LENGTH = 2;
export const SOFTWARE_MAX_LENGTH = 200;

export const TURNAROUND_MIN_LENGTH = 2;
export const TURNAROUND_MAX_LENGTH = 200;

/** The anti-slop field. Longer floor than the other two: "looks good" is not an
 *  observation, and a ten-character minimum is the cheapest way to say so. */
export const NOTICED_MIN_LENGTH = 10;
export const NOTICED_MAX_LENGTH = 300;

/** Spec §6: "three short fields (300 characters total)". `job_opt_ins_total_length`. */
export const OPT_IN_TOTAL_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/**
 * One page of the feed. There is no cursor yet: the board is small, jobs expire
 * after a week, and the page says so when it truncates rather than pretending
 * the bottom of the list is the end of it.
 */
export const FEED_PAGE_SIZE = 50;

/** Search param the category filter writes. */
export const FEED_CATEGORY_PARAM = "category";

// ---------------------------------------------------------------------------
// The shortlist (spec §5)
// ---------------------------------------------------------------------------

/**
 * Spec §5 shows the client up to five workers in three slot types, the middle
 * three AI-ranked. Spec §16 cuts that from V1 in one line — "AI ranking of
 * middle 3 → show all opted-in workers sorted by rating" — so this screen has
 * no slots, no cap and no stored shortlist: every opted-in worker, best-rated
 * first. `job_shortlists` and `job_shortlist_entries` stay empty until the
 * ranking exists to record.
 *
 * The bound below is a page size, not the spec's five. A job that draws more
 * opt-ins than this is a signal worth seeing rather than a list worth padding.
 */
export const SHORTLIST_PAGE_SIZE = 50;

/**
 * How long a sample preview link lives. Longer than the worker's own 60 seconds
 * because a client is comparing portfolios side by side, and short enough that
 * a copied URL is worthless by the time it is pasted anywhere.
 */
export const SHORTLIST_URL_TTL_SECONDS = 600;

/** Search param the shortlist navigates back with once a payment has settled. */
export const SHORTLIST_PICKED_PARAM = "picked";
