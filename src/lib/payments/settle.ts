/**
 * Capture and settle — the half of payment that runs after Razorpay has the
 * money, shared by the client's own confirmation and by the webhook.
 *
 * **Deliberately not a Server Action.** Everything here is decided from
 * parameters, and a `"use server"` export is a URL the browser can post to:
 * exporting this alongside the actions would hand anyone a way to settle an
 * arbitrary payment row for an arbitrary amount on behalf of an arbitrary
 * actor. Both callers establish who is asking *before* they get here —
 * `confirmJobPayment` from the session and the checkout signature, the webhook
 * from the body signature — and this function trusts that and nothing else.
 *
 * It re-reads Razorpay for the payment's real order, amount and status, because
 * a signature proves who sent a message, not what is true. Only an amount that
 * matches the price frozen on our own row gets captured.
 */

import { revalidatePath } from "next/cache";

import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { notifyJobAssigned } from "@/lib/email/events";
import {
  RazorpayError,
  capturePayment,
  fetchPayment,
} from "@/lib/payments/razorpay";
import type { ConfirmPaymentResult } from "@/lib/payments/types";
import { createServiceRoleClient } from "@/lib/supabase/server";

/** What a client should read when Razorpay itself refuses or is unreachable. */
export function describeGatewayError(error: unknown, context: string): string {
  if (error instanceof RazorpayError) {
    console.error(`[payments] ${context}: ${error.message}`);
    return error.retryable
      ? "We couldn't reach the payment provider. Try again in a moment."
      : "The payment provider turned that down. Try a different card or method.";
  }

  console.error(`[payments] ${context}:`, error);
  return "Something went wrong taking that payment. Try again.";
}

function retryable(error: unknown): boolean {
  return error instanceof RazorpayError ? error.retryable : true;
}

export async function settleCapturedPayment({
  paymentRowId,
  jobId,
  orderId,
  amountPaise,
  razorpayPaymentId,
  actorId,
}: {
  paymentRowId: string;
  jobId: string;
  orderId: string;
  /** The price frozen on our row. Never a number from a browser or a webhook. */
  amountPaise: number;
  razorpayPaymentId: string;
  /** Null from the webhook, which knows the payment but not who is at a keyboard. */
  actorId: string | null;
}): Promise<ConfirmPaymentResult> {
  const admin = createServiceRoleClient();

  let gatewayPayment;
  try {
    gatewayPayment = await fetchPayment(razorpayPaymentId);
  } catch (error) {
    return {
      ok: false,
      error: describeGatewayError(error, `fetchPayment ${razorpayPaymentId}`),
      retryable: retryable(error),
    };
  }

  // A signature proves provenance, not amount. This is where a real payment for
  // a different order, or for the wrong money, stops.
  if (gatewayPayment.order_id !== orderId) {
    console.error(
      `[payments] payment ${razorpayPaymentId} is for order ${gatewayPayment.order_id}, not ${orderId}`,
    );
    return { ok: false, error: "That payment doesn't match this job.", retryable: false };
  }

  if (gatewayPayment.amount !== amountPaise) {
    console.error(
      `[payments] payment ${razorpayPaymentId} is ${gatewayPayment.amount} paise, expected ${amountPaise}`,
    );
    return { ok: false, error: "That payment was for the wrong amount.", retryable: false };
  }

  if (gatewayPayment.status === "failed") {
    await admin.rpc("fail_job_payment", {
      p_payment_id: paymentRowId,
      p_reason:
        gatewayPayment.error_description ?? gatewayPayment.error_code ?? "declined",
    });
    return { ok: false, error: "That payment didn't go through. Try again.", retryable: true };
  }

  if (gatewayPayment.status !== "authorized" && gatewayPayment.status !== "captured") {
    return { ok: false, error: "That payment hasn't completed. Try again.", retryable: true };
  }

  let captured = gatewayPayment;
  if (gatewayPayment.status === "authorized") {
    try {
      captured = await capturePayment({ paymentId: razorpayPaymentId, amountPaise });
    } catch (error) {
      return {
        ok: false,
        error: describeGatewayError(error, `capturePayment ${razorpayPaymentId}`),
        retryable: retryable(error),
      };
    }
  }

  // Razorpay's `fee` is the whole charge and `tax` is the GST inside it, so the
  // fee proper is the difference. Splitting them here keeps `gateway_fee_paise`
  // a cost and `gateway_tax_paise` a tax, which is what the ledger needs.
  const feeTotal = captured.fee ?? 0;
  const feeTax = captured.tax ?? 0;

  // `razorpay_payment_id` is the token settlement reads as "the gateway has the
  // money", so it is written only here, after the capture above returned. The
  // status filter means a row already settled is not walked backwards by a late
  // webhook.
  const { error: markError } = await admin
    .from("payments")
    .update({
      status: "authorized",
      razorpay_payment_id: razorpayPaymentId,
      method: captured.method,
      gateway_fee_paise: Math.max(feeTotal - feeTax, 0),
      gateway_tax_paise: feeTax,
    })
    .eq("id", paymentRowId)
    .in("status", ["created", "authorized"]);

  if (markError) {
    console.error(
      `[payments] could not record capture of ${razorpayPaymentId}: ${markError.message}`,
    );
    return {
      ok: false,
      error:
        "Your payment went through but we couldn't record it. We're on it — please don't pay again.",
      retryable: false,
    };
  }

  // Escrow, the ledger and the assignment, in one transaction. Idempotent: the
  // browser and the webhook both call this, and the second one finds it done.
  // The webhook has no actor, and the generated types model an omitted argument
  // rather than an explicit null — so the parameter is left off and the
  // function's own `default null` applies, which is what null meant here.
  // Settlement then falls back to the payment's own client.
  const { data: assignment, error: settleError } = await admin.rpc(
    "settle_job_payment_and_assign",
    { p_payment_id: paymentRowId, ...(actorId ? { p_actor_id: actorId } : {}) },
  );

  if (settleError || !assignment) {
    console.error(
      `[payments] settle failed for ${paymentRowId}: ${settleError?.message ?? "no row"}`,
    );
    // The money is captured. Offering a retry here invites a second charge for
    // a job that may already be assigned, so this one deliberately does not.
    return {
      ok: false,
      error:
        "Your payment went through but we couldn't finish assigning the job. We're on it — please don't pay again.",
      retryable: false,
    };
  }

  // The receipt and the worker's "you've been picked". Both keyed on the job,
  // so the browser and the webhook arriving in either order send one of each.
  // It cannot throw, and it is awaited rather than left dangling: a serverless
  // function that has returned its response may be frozen mid-promise.
  await notifyJobAssigned(jobId);

  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.shortlist(jobId));
  // The worker's side changes too: the job leaves the open feed, their opt-in
  // becomes selected, and everyone else's becomes not_selected.
  revalidatePath(WORKER_ROUTES.feed);
  revalidatePath(WORKER_ROUTES.job(jobId));
  revalidatePath(WORKER_ROUTES.optIns);

  return { ok: true, workerId: assignment.worker_id };
}
