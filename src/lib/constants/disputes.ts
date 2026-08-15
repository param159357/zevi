/**
 * Dispute constants — spec §11.
 *
 * Same rule as every other constant file here: the authority is elsewhere. The
 * two lengths mirror the CHECK on `dispute_statements.body`; the three clocks
 * mirror `platform_settings` rows that `open_dispute()` reads once, at the
 * moment a case is raised, and stores as instants on the row. A client told
 * "five days" gets five days even if the setting moves on day three — the copy
 * here is for a form that has not been submitted yet.
 */

/** `dispute_statements_body_check`: 20 to 500. Spec §11 asks for "a required
 *  500-character statement from each", which is a ceiling and a requirement,
 *  not a target — the floor is the schema's way of refusing "it's wrong". */
export const STATEMENT_MIN_LENGTH = 20;
export const STATEMENT_MAX_LENGTH = 500;

/** `disputes.reason_summary`: 10 to 500. The one-line version, shown at the top
 *  of the console queue. */
export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 500;

/** Spec §11's three stated clocks, in the units the screen says them in.
 *  `dispute.response_hours`, `dispute.first_response_hours`,
 *  `dispute.decision_days`. */
export const RESPONSE_HOURS = 24;
export const FIRST_RESPONSE_HOURS = 48;
export const DECISION_DAYS = 5;

/** Spec §11: "Client window: delivery until 48h after acceptance."
 *  `dispute.post_acceptance_hours`. */
export const POST_ACCEPTANCE_HOURS = 48;

export const DISPUTE_ROUTES = {
  /** One case, read by whichever party is signed in. Its own top-level segment
   *  rather than a child of `/review` or `/worker/work`, because both sides open
   *  the same screen and neither route group owns it. */
  case: (disputeId: string) => `/disputes/${disputeId}`,
  raise: (jobId: string) => `/disputes/raise/${jobId}`,
} as const;
