/**
 * Payment constants — spec §4, §8 and §9.
 *
 * Same rule as the other constant files: a number here has its authority
 * somewhere else. The commission rates do not live here at all — they are
 * versioned rows in `commission_slabs` and `tax_rates`, loaded by
 * `lib/money/rates.ts`, because a rate that changes must leave the old one
 * readable. What lives here is the gateway's own arithmetic and the shape of
 * the Razorpay integration, neither of which is ours to version.
 */

/**
 * Razorpay's cut of a domestic card or UPI charge, and GST on top of it.
 *
 * Spec §8 quotes the pair as "≈2.36% of what the client actually pays" and
 * spec §9 prices a month of jobs on it. It is an *estimate* — the real figure
 * arrives on the payment entity as `fee` and `tax`, differs by instrument, and
 * is what gets written to `payments.gateway_fee_paise`. Nothing that touches
 * the ledger may use the numbers below: they are for the "Zevi net" column in
 * a projection, and `estimateNetRevenue` is the only thing that reads them.
 */
export const GATEWAY_FEE_BPS = 200;
export const GATEWAY_FEE_TAX_BPS = 1_800;

/** Razorpay speaks paise, and so do we — no conversion at the boundary. */
export const PAYMENT_CURRENCY = "INR";

/**
 * Razorpay Checkout, loaded in the browser at the moment a client picks someone.
 * Deliberately not bundled: the script is versioned by Razorpay and card data
 * must never touch an origin of ours.
 */
export const CHECKOUT_SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";

/**
 * An order outlives the tab it was created in. If a client abandons checkout
 * and comes back, the open order for that job is reused rather than a second
 * one created — Razorpay bills nothing for an unpaid order, but two live orders
 * for one job is the shape a double charge comes in.
 */
export const ORDER_REUSE_WINDOW_MINUTES = 15;

/** Razorpay's `notes` are the only thing that survives a round trip through the
 *  gateway, so the settlement path can find its way back to the job from a
 *  webhook that carries nothing else. Never trusted as authorisation: the
 *  payment row is looked up by `razorpay_order_id` and its own columns win. */
export const ORDER_NOTE_KEYS = {
  jobId: "job_id",
  optInId: "opt_in_id",
  workerId: "worker_id",
} as const;

/** Webhook events we act on. Anything else is acknowledged and ignored — an
 *  unrecognised event is not an error, and 200 stops Razorpay retrying it. */
export const HANDLED_WEBHOOK_EVENTS = [
  "payment.captured",
  "payment.failed",
] as const;

export type HandledWebhookEvent = (typeof HANDLED_WEBHOOK_EVENTS)[number];
