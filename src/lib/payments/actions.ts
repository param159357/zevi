"use server";

/**
 * Paying for a hire — spec §4, step 5: "client picks one, payment happens here,
 * into escrow".
 *
 * Two actions, because a card payment is two round trips with a browser in the
 * middle and the middle is not trusted:
 *
 *   startJobPayment()    prices the job, freezes that price, opens a Razorpay
 *                        order, and hands the browser three ids
 *   confirmJobPayment()  checks what came back, then hands off to
 *                        `settleCapturedPayment` — capture, escrow, ledger and
 *                        assignment, in one transaction
 *
 * What the browser is allowed to decide: nothing. It names a payment row and a
 * Razorpay payment id and offers a signature. The order id is read from our own
 * row, the amount is recomputed from the job, and the worker comes off the
 * opt-in the payment was raised against. Every one of those was written before
 * the client was shown a payment form.
 *
 * Every export in this file is a URL the browser can post to, so there are
 * exactly two, and both start by re-deriving the caller from the session.
 *
 * Rules that hold in both:
 *   * reads that establish *what the client may see* go through the client's
 *     own Supabase client, so RLS decides. Writes that move money go through
 *     the service-role client, because `payments`, `escrow_holds`,
 *     `job_financials` and the `ledger_*` tables have INSERT revoked from
 *     `authenticated` — that is the policy, not a workaround for one
 *   * the database has the last word on eligibility. `open_job_payment` takes
 *     the row lock and re-checks the job, the opt-in and the worker; the checks
 *     here exist to give a decent sentence before a card is touched
 */

import { requireRole } from "@/lib/auth/session";
import {
  ORDER_NOTE_KEYS,
  ORDER_REUSE_WINDOW_MINUTES,
  PAYMENT_CURRENCY,
} from "@/lib/constants/payments";
import { isRazorpayConfigured, publicEnv, serverEnv } from "@/lib/env";
import { PICKABLE_OPT_IN_STATUSES } from "@/lib/matching/shortlist";
import { quoteJob } from "@/lib/payments/quote";
import { createOrder } from "@/lib/payments/razorpay";
import { describeGatewayError, settleCapturedPayment } from "@/lib/payments/settle";
import { verifyCheckoutSignature } from "@/lib/payments/signature";
import type { ConfirmPaymentResult, StartPaymentResult } from "@/lib/payments/types";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Razorpay ids are `order_…` / `pay_…` and short. Anything else never reaches
 *  the API — an id is interpolated into a URL path, so it is checked, not
 *  merely escaped. */
const GATEWAY_ID_PATTERN = /^[A-Za-z]{3,10}_[A-Za-z0-9]{6,30}$/;

const PAYMENT_UNAVAILABLE =
  "Card payments aren't switched on for this deployment yet, so this job can't be assigned.";

/**
 * A raise out of `open_job_payment`, as a sentence. Every one is reachable
 * without a bug — a worker who withdrew while the client was reading, a second
 * tab, a job that expired mid-decision. The log keeps the original.
 */
function describeRpcError(
  error: { code?: string; message: string },
  context: string,
): string {
  console.error(`[payments] ${context} failed ${error.code ?? "?"}: ${error.message}`);

  if (error.message.includes("already has an active assignment")) {
    return "This job already has a worker on it. Reload to see who.";
  }
  if (error.message.includes("already has a payment in flight")) {
    return "There's already a payment being taken for this job. Reload before trying again.";
  }
  if (
    error.message.includes("cannot be paid for") ||
    error.message.includes("cannot be assigned")
  ) {
    return "This job isn't open any more. Reload to see where it got to.";
  }
  if (error.message.includes("cannot be selected")) {
    return "That worker has withdrawn. Reload to see who's still available.";
  }
  if (error.message.includes("is not eligible to take work")) {
    return "That worker can't take this job any more. Pick someone else.";
  }
  if (error.code === "42501" || error.message.includes("only the client")) {
    return "That job isn't yours to assign.";
  }
  return "We couldn't set that payment up. Try again.";
}

// ---------------------------------------------------------------------------
// Opening the charge
// ---------------------------------------------------------------------------

export async function startJobPayment(input: {
  jobId: string;
  optInId: string;
}): Promise<StartPaymentResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  if (!isRazorpayConfigured()) {
    console.error(
      "[payments] NEXT_PUBLIC_RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set.",
    );
    return { ok: false, error: PAYMENT_UNAVAILABLE };
  }

  if (!UUID_PATTERN.test(input.jobId) || !UUID_PATTERN.test(input.optInId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  // `clients read opt-ins on their own jobs` is what returns this, so a job
  // that is not theirs comes back empty rather than forbidden. The worker is
  // read off the row — the browser never names who is being hired.
  const { data: optIn, error: optInError } = await supabase
    .from("job_opt_ins")
    .select("id, worker_id, status")
    .eq("id", input.optInId)
    .eq("job_id", input.jobId)
    .maybeSingle();

  if (optInError) {
    console.error(`[payments] could not read opt-in ${input.optInId}: ${optInError.message}`);
    return { ok: false, error: "We couldn't check that opt-in. Try again." };
  }

  if (!optIn) {
    return { ok: false, error: "That worker isn't on this job's list. Reload the page." };
  }

  if (!PICKABLE_OPT_IN_STATUSES.includes(optIn.status)) {
    return {
      ok: false,
      error:
        optIn.status === "withdrawn"
          ? "That worker has withdrawn. Reload to see who's still available."
          : "This job has already been assigned. Reload to see who's on it.",
    };
  }

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, title, budget_paise, status")
    .eq("id", input.jobId)
    .maybeSingle();

  if (jobError || !job) {
    console.error(
      `[payments] could not read job ${input.jobId}: ${jobError?.message ?? "no row"}`,
    );
    return { ok: false, error: "We couldn't load that job. Reload the page." };
  }

  // `jobs_publishable` guarantees both on anything past draft. A draft has no
  // opt-ins to pay for, so this is a reload, not a validation message.
  if (job.budget_paise === null || job.title === null) {
    return { ok: false, error: "This job isn't finished being posted yet." };
  }

  // The price the client is charged is computed here, from the job's own budget
  // and the rates in effect — never from anything the page was handed.
  let quote;
  try {
    quote = await quoteJob(supabase, job.budget_paise);
  } catch (error) {
    console.error("[payments] could not price the job:", error);
    return { ok: false, error: "We couldn't work out the price for this job. Try again." };
  }

  const admin = createServiceRoleClient();

  // Freezes the price, refuses a second charge, and returns either a fresh
  // payment row or the live one this client already has open.
  // Returns one `payments` row, not a set, so there is no `.single()` here —
  // PostgREST hands back the composite directly.
  const { data: payment, error: openError } = await admin.rpc("open_job_payment", {
    p_job_id: input.jobId,
    p_opt_in_id: optIn.id,
    p_actor_id: context.user.id,
    p_slab_id: quote.slabId,
    p_tax_rate_id: quote.taxRateId,
    p_price: quote.price,
    p_reuse_minutes: ORDER_REUSE_WINDOW_MINUTES,
  });

  if (openError || !payment) {
    return {
      ok: false,
      error: openError
        ? describeRpcError(openError, `open_job_payment on ${input.jobId}`)
        : "We couldn't set that payment up. Try again.",
    };
  }

  const workerName = await loadWorkerName(supabase, optIn.worker_id);

  const handoff = {
    paymentId: payment.id,
    keyId: publicEnv.razorpayKeyId,
    amountPaise: payment.amount_paise,
    currency: PAYMENT_CURRENCY,
    jobTitle: job.title,
    workerName,
    prefill: {
      name: context.profile.full_name ?? context.profile.display_name,
      email: context.profile.email,
      contact: context.profile.mobile,
    },
  };

  // A live order from a checkout the client closed. Reopening it is what stops
  // an abandoned modal turning into a second charge.
  if (payment.razorpay_order_id) {
    return { ok: true, checkout: { ...handoff, orderId: payment.razorpay_order_id } };
  }

  let order;
  try {
    order = await createOrder({
      amountPaise: payment.amount_paise,
      // The dashboard row points back at the job without a lookup table.
      receipt: payment.id,
      notes: {
        [ORDER_NOTE_KEYS.jobId]: input.jobId,
        [ORDER_NOTE_KEYS.optInId]: optIn.id,
        [ORDER_NOTE_KEYS.workerId]: optIn.worker_id,
      },
    });
  } catch (error) {
    return { ok: false, error: describeGatewayError(error, "createOrder") };
  }

  const { error: attachError } = await admin
    .from("payments")
    .update({ razorpay_order_id: order.id })
    .eq("id", payment.id);

  if (attachError) {
    // The order exists at Razorpay but we have no way back to it. Nothing has
    // been charged; failing here is cheaper than a checkout we could not settle.
    console.error(`[payments] could not attach order ${order.id}: ${attachError.message}`);
    return { ok: false, error: "We couldn't set that payment up. Try again." };
  }

  return { ok: true, checkout: { ...handoff, orderId: order.id } };
}

// ---------------------------------------------------------------------------
// Settling it
// ---------------------------------------------------------------------------

/**
 * What Razorpay Checkout hands back, checked and then acted on.
 *
 * The order of the checks is the point. The signature proves this payment id
 * belongs to *our* order — compared against the id on our own row, not the one
 * the browser sent, so a valid signature for someone else's order proves
 * nothing here. Only then is Razorpay asked what the payment actually is.
 *
 * Safe to call twice. The `payment.captured` webhook settles the same payment
 * by the same route, and whichever arrives second finds the work done.
 */
export async function confirmJobPayment(input: {
  paymentId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<ConfirmPaymentResult> {
  const context = await requireRole("client");

  if (!isRazorpayConfigured()) {
    return { ok: false, error: PAYMENT_UNAVAILABLE, retryable: false };
  }

  if (!UUID_PATTERN.test(input.paymentId)) {
    return { ok: false, error: "That payment doesn't exist.", retryable: false };
  }

  if (!GATEWAY_ID_PATTERN.test(input.razorpayPaymentId)) {
    return { ok: false, error: "That payment reference isn't valid.", retryable: false };
  }

  const admin = createServiceRoleClient();

  const { data: payment, error: readError } = await admin
    .from("payments")
    .select("id, job_id, client_id, status, amount_paise, razorpay_order_id")
    .eq("id", input.paymentId)
    .maybeSingle();

  if (readError || !payment) {
    console.error(
      `[payments] could not read payment ${input.paymentId}: ${readError?.message ?? "no row"}`,
    );
    return { ok: false, error: "We couldn't find that payment.", retryable: false };
  }

  // The service-role read above bypasses RLS, so the ownership check that
  // `clients read their own payments` would have made is made here instead.
  if (payment.client_id !== context.user.id) {
    console.error(
      `[payments] ${context.user.id} tried to confirm payment ${payment.id}, owned by ${payment.client_id}`,
    );
    return { ok: false, error: "That payment isn't yours.", retryable: false };
  }

  if (!payment.razorpay_order_id) {
    return { ok: false, error: "That payment was never opened.", retryable: false };
  }

  if (
    !verifyCheckoutSignature({
      orderId: payment.razorpay_order_id,
      paymentId: input.razorpayPaymentId,
      signature: input.razorpaySignature,
      keySecret: serverEnv.razorpayKeySecret,
    })
  ) {
    console.error(`[payments] bad checkout signature on payment ${payment.id}`);
    return {
      ok: false,
      error: "We couldn't verify that payment. Nothing has been charged — try again.",
      retryable: true,
    };
  }

  return settleCapturedPayment({
    paymentRowId: payment.id,
    jobId: payment.job_id,
    orderId: payment.razorpay_order_id,
    amountPaise: payment.amount_paise,
    razorpayPaymentId: input.razorpayPaymentId,
    actorId: context.user.id,
  });
}

// ---------------------------------------------------------------------------

/** The name Razorpay's modal shows. `public_profiles.display_name` is a first
 *  name, not the legal name on an ID — a client never touches `profiles`. */
async function loadWorkerName(
  supabase: Awaited<ReturnType<typeof createClient>>,
  workerId: string,
): Promise<string> {
  const { data } = await supabase
    .from("public_profiles")
    .select("display_name")
    .eq("profile_id", workerId)
    .maybeSingle();

  return data?.display_name ?? "the worker";
}
