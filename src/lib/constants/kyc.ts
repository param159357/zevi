/**
 * KYC constants — spec §6, "KYC — before first payout, not at signup".
 *
 * Same rule as the payout and delivery constants: every number here has its
 * authority in the database — a `platform_settings` row migration 0033 reads, or
 * a CHECK on `worker_kyc` / `payout_methods`. These copies let a form validate
 * before a round trip and let a label quote the rule. A stale constant makes a
 * message wrong, never a verification loose.
 */

/** `platform_settings`: kyc.max_attempts. Spec §6: "3 failed attempts → admin
 *  review." Counted by `open_worker_kyc_attempt()`, which is the ceiling. */
export const KYC_MAX_ATTEMPTS = 3;

/**
 * `platform_settings`: kyc.pan_required_above_paise. Spec §6 puts PAN against
 * TDS and makes it "mandatory above ₹5,000 lifetime"; under that line "UPI alone
 * is enough". The lifetime figure is what the worker has actually earned and not
 * had taken back — `worker_lifetime_earnings_paise()` in migration 0033 is what
 * decides it, and this copy is for the sentence on the form.
 */
export const PAN_REQUIRED_ABOVE_PAISE = 500_000;

/**
 * `platform_settings`: kyc.name_match_min_bps, as a 0–1 score.
 *
 * The one number in this file that is not merely a label. Spec §6 makes a name
 * mismatch a block with no override, so where this sits decides who is turned
 * away permanently — too high and a bank that stores "R K SHARMA" ends a real
 * worker's account, too low and the rule means nothing. `compareNames` in
 * `lib/kyc/names.ts` is written against the ways Indian names legitimately vary
 * (initials, order, honorifics, an extra middle name on one side only), and
 * `names.test.ts` is where the pairs that must pass and must fail are written
 * down. The threshold is read from `platform_settings` at decision time; this is
 * the fallback when that read fails.
 */
export const NAME_MATCH_MIN_SCORE = 0.85;

/** `platform_settings`: kyc.penny_drop_amount_paise. Razorpay's own default,
 *  and the ₹3–5 per worker spec §6 budgets is the API fee, not this. */
export const PENNY_DROP_AMOUNT_PAISE = 100;

// ---------------------------------------------------------------------------
// Shapes
//
// All three are also enforced in Postgres — `payout_methods_ifsc_check`,
// `worker_kyc_pan_last4_check` — or by Razorpay refusing the account. These
// patterns exist so a worker learns about a typo before a penny drop is spent
// on it.
// ---------------------------------------------------------------------------

/**
 * Five letters, four digits, one letter. The fourth character is the holder
 * type — `P` for an individual — and it is deliberately not enforced: a sole
 * proprietor's PAN can be a firm's, and if that firm is not them the name match
 * is what catches it, which is the check that should.
 */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Four letters, a zero, six alphanumerics. Mirrors the CHECK on
 *  `payout_methods.ifsc` exactly. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Indian bank account numbers run 9–18 digits; a few older ones are shorter.
 *  Razorpay is the authority — this only catches the obviously wrong. */
export const ACCOUNT_NUMBER_PATTERN = /^[0-9]{6,18}$/;

/** A UPI handle: `name@bank`. The local part allows the dots, hyphens and
 *  underscores every PSP issues; the suffix is letters and digits. */
export const UPI_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9.\-_]{0,255})@[a-zA-Z][a-zA-Z0-9.\-_]{1,63}$/;

/** Spec §6: date of birth is an 18+ confirmation, and `enforce_kyc_adult()` is
 *  what actually refuses. 100 is a sanity ceiling on a mistyped year. */
export const MIN_AGE_YEARS = 18;
export const MAX_AGE_YEARS = 100;

export const LEGAL_NAME_MIN_LENGTH = 2;
export const LEGAL_NAME_MAX_LENGTH = 120;
