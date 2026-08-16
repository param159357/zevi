/**
 * The refund drain — spec §14, and the last thing standing between a decided
 * cancellation and a client's card.
 *
 * **Server-only, and deliberately not a Server Action.** A `"use server"` file
 * here would hand the browser a URL that sends money out of the platform
 * account. Nothing in this module is reachable from a request a user makes; it
 * is called by `/api/cron/refunds`, behind the same bearer token as the payout
 * run.
 *
 * ### Why this is a queue and not a call at the end of `cancelJob`
 *
 * Same reason the outbox is (spec §15), with more at stake. A client pressing
 * "cancel" is inside a transaction that divides escrow, writes the ledger, opens
 * the worker's earning and moves the cancellation rate on their profile. Putting
 * a Razorpay round trip in front of that either happens *before* the commit —
 * where a timeout unwinds a decision that has already been made and told to two
 * people — or *after* it, where a failure has nowhere to be recorded. Writing the
 * instruction down and coming back for it is the only shape with a good answer
 * to "what if the gateway is down", and 0012 built the row for it years before
 * anyone reached this file.
 *
 * ### The submission is the dangerous part
 *
 * Razorpay's refund endpoint has no idempotency key. A repeated POST is a second
 * refund, and a second refund is real money that does not come back. Three
 * things stand in the way, in order:
 *
 *   1. `claim_refund_batch()` takes `for update skip locked`, so two drains
 *      overlapping cannot both hold the same row
 *   2. a retry — a row already carrying an attempt — asks Razorpay whether our
 *      reference is already on a refund before it submits anything, which covers
 *      exactly the case our own rows cannot: accepted, never recorded
 *   3. `mark_refund_completed()` refuses to credit escrow more than the job has
 *      left in it, so a double refund cannot balance even if it happens
 *
 * The first is a lock, the second is a question, the third is arithmetic. None
 * of them is sufficient alone.
 */

import {
  REFUND_BATCH_SIZE,
  refundRetryDelaySeconds,
} from "@/lib/constants/refunds";
import { notifyRefundIssued } from "@/lib/email/events";
import {
  RazorpayError,
  type RazorpayRefund,
  createRefund,
  fetchRefund,
  findRefundByReference,
} from "@/lib/payments/razorpay";
import { absorbedGatewayCostPaise } from "@/lib/refunds/absorption";
import type { RefundDrainSummary, RefundOutcome } from "@/lib/refunds/types";
import { createServiceRoleClient } from "@/lib/supabase/server";

/** Razorpay's three words, translated once, at the boundary. */
function outcomeOf(refund: RazorpayRefund): RefundOutcome {
  switch (refund.status) {
    case "processed":
      return "settled";
    case "failed":
      return "rejected";
    default:
      return "accepted";
  }
}

/**
 * Issue what is due.
 *
 * Sequential, like the outbox drain, and for a firmer reason: Razorpay rate
 * limits the payment APIs, and a `Promise.all` over ten refunds is the shape
 * that trips it. Ten one at a time is a couple of seconds, and a limit that
 * does arrive costs one refund rather than the batch.
 *
 * Each row is claimed with its attempt already counted, so nothing below can
 * loop: the worst case is `refund.max_attempts` submissions of a refund that
 * kills the drain, and then a `failed` row somebody can read.
 */
export async function drainRefunds(limit: number = REFUND_BATCH_SIZE): Promise<RefundDrainSummary> {
  const admin = createServiceRoleClient();

  const { data: claimed, error } = await admin.rpc("claim_refund_batch", { p_limit: limit });

  if (error) {
    console.error(`[refunds] could not claim a batch: ${error.message}`);
    throw new Error(error.message);
  }

  const summary: RefundDrainSummary = {
    claimed: claimed?.length ?? 0,
    submitted: 0,
    completed: 0,
    retrying: 0,
    failed: 0,
  };

  for (const row of claimed ?? []) {
    try {
      if (!row.razorpay_payment_id) {
        // 0036 only ever writes a refund against a `captured` payment, so this
        // is a payment row that lost its gateway id — a bug on our side, not a
        // gateway problem, and not one more attempts will fix.
        //
        // The generated types say this column cannot be null, and they are
        // wrong: Supabase's generator types every `returns table` column as
        // non-null because the function signature does not say otherwise, while
        // `payments.razorpay_payment_id` is plainly nullable. So the check stays
        // — it is a real runtime possibility that only looks impossible.
        throw new RazorpayError(`payment ${row.payment_id} has no gateway payment id`, {
          status: 400,
          code: "MissingGatewayPayment",
        });
      }

      const gateway = await issue({
        id: row.id,
        // Narrowed by the guard above. Passed explicitly rather than as part of
        // `row`, because narrowing a property does not narrow the object it is
        // on, and a non-null assertion on a value that came from the database is
        // exactly what this codebase does not do.
        gatewayPaymentId: row.razorpay_payment_id,
        gatewayRefundId: row.razorpay_refund_id,
        amountPaise: row.amount_paise,
        attempts: row.attempts,
      });
      const outcome = outcomeOf(gateway);

      if (outcome === "rejected") {
        // Razorpay tried and the acquirer said no — usually a closed card. The
        // instruction is spent, so this is terminal: retrying posts a *new*
        // refund to the same dead instrument. A person has to reach the client.
        const { data: status } = await admin.rpc("mark_refund_failed", {
          p_id: row.id,
          p_error: `Razorpay refund ${gateway.id} failed at the acquirer`,
        });

        summary.failed += 1;
        console.error(
          `[refunds] ${row.id} was rejected by the gateway (${gateway.id}), left ${status}`,
        );
        continue;
      }

      if (outcome === "settled") {
        const { data: status, error: completeError } = await admin.rpc("mark_refund_completed", {
          p_id: row.id,
          p_razorpay_refund_id: gateway.id,
          p_gateway_fee_paise: absorbedGatewayCostPaise({
            cost: {
              gatewayFeePaise: row.gateway_fee_paise,
              gatewayTaxPaise: row.gateway_tax_paise,
            },
            chargedPaise: row.charged_paise,
            refundedPaise: row.amount_paise,
          }),
        });

        if (completeError) {
          // The money has gone and we could not write that down. Loud, and left
          // `processing` so the next run polls it and tries the write again —
          // `mark_refund_completed` is idempotent on the row lock and on the
          // ledger key, so repeating it is the safe half of this trade.
          throw new Error(`refunded but not recorded: ${completeError.message}`);
        }

        summary.completed += 1;

        if (status === "completed") {
          await notifyRefundIssued({
            refundId: row.id,
            jobId: row.job_id,
            amountPaise: row.amount_paise,
            reason: row.reason,
          });
        }

        continue;
      }

      // Accepted, not finished. The ordinary case on a card: Razorpay has the
      // instruction, the acquirer has days. Nothing is written to the ledger —
      // money has not moved — and the row is polled from here on.
      const { error: submitError } = await admin.rpc("mark_refund_submitted", {
        p_id: row.id,
        p_razorpay_refund_id: gateway.id,
      });

      if (submitError) {
        throw new Error(`submitted but not recorded: ${submitError.message}`);
      }

      summary.submitted += 1;

      // Told now rather than on completion. Spec §14 promises 5–7 working days
      // and the template says so, which is a sentence that is true from the
      // moment the gateway accepts and stale by the time it settles. Deduped on
      // the refund, so a poll that later completes does not send a second.
      await notifyRefundIssued({
        refundId: row.id,
        jobId: row.job_id,
        amountPaise: row.amount_paise,
        reason: row.reason,
      });
    } catch (cause) {
      const retryable = cause instanceof RazorpayError ? cause.retryable : true;
      const reason = cause instanceof Error ? cause.message : "unknown error";

      const retryAt = retryable
        ? new Date(Date.now() + refundRetryDelaySeconds(row.attempts) * 1000)
        : null;

      const { data: status } = await admin.rpc("mark_refund_failed", {
        p_id: row.id,
        p_error: reason,
        ...(retryAt ? { p_retry_at: retryAt.toISOString() } : {}),
      });

      if (status === "pending") {
        summary.retrying += 1;
        console.warn(`[refunds] ${row.id} failed, retrying: ${reason}`);
      } else {
        summary.failed += 1;
        console.error(
          `[refunds] ${row.id} failed after ${row.attempts} attempt(s): ${reason}`,
        );
      }
    }
  }

  return summary;
}

type RefundToIssue = {
  /** Our `refunds` row id, which is also the reference stamped into the notes. */
  id: string;
  gatewayPaymentId: string;
  gatewayRefundId: string | null;
  amountPaise: number;
  attempts: number;
};

/**
 * Get an answer out of Razorpay about one refund, whichever half of its life it
 * is in.
 *
 * Three paths, and the middle one is the whole reason this is a function rather
 * than two lines at the call site:
 *
 *   * **already submitted** — poll it. The id is ours to quote back.
 *   * **a retry** — ask whether our reference is already on a refund *before*
 *     posting one. This is the only check that covers an accepted refund we
 *     never recorded, which is exactly what a timed-out POST leaves behind, and
 *     it is why `createRefund` stamps the row id into the notes.
 *   * **a first attempt** — submit. There is nothing to find, and a lookup would
 *     be an API call spent confirming that.
 *
 * The property that makes the middle path sufficient: the attempt is counted at
 * the *claim*, so every way a submission can happen without being recorded — a
 * timeout, a killed process, a `mark_refund_*` write that failed after the POST
 * — leaves the row with at least one attempt spent. The next claim takes it to
 * two, and two is what turns the lookup on. There is no route from "Razorpay has
 * a refund of ours" back into the `attempts === 1` branch.
 */
async function issue(refund: RefundToIssue): Promise<RazorpayRefund> {
  if (refund.gatewayRefundId) {
    return fetchRefund(refund.gatewayRefundId);
  }

  if (refund.attempts > 1) {
    const existing = await findRefundByReference({
      paymentId: refund.gatewayPaymentId,
      refundId: refund.id,
    });

    if (existing) {
      console.warn(
        `[refunds] ${refund.id} was already at the gateway as ${existing.id}; not sending a second`,
      );
      return existing;
    }
  }

  return createRefund({
    paymentId: refund.gatewayPaymentId,
    amountPaise: refund.amountPaise,
    refundId: refund.id,
  });
}
