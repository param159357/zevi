"use server";

/**
 * Cancelling a job — spec §5.
 *
 * The same rules that hold everywhere else in this codebase hold here:
 *
 *   * whoever is acting is re-derived from the session, never taken from the
 *     payload. A form that renders is not authorisation, and
 *     `request_job_cancellation()` checks the client id again under the job's
 *     row lock
 *   * no amount crosses this boundary. The action names a job and a reason; the
 *     function reads every rupee off the frozen `job_financials` row and works
 *     the tier out from its own clock. There is no number in the signature for a
 *     browser to lie about
 *   * one transaction or none of it. Escrow, the ledger, the worker's earning,
 *     the queued refund, the job, the assignment, the opt-ins and the client's
 *     cancellation rate all move together
 *
 * The one thing this file decides on its own is what a client is *told*, which
 * is why the switch below is long: "cancelled" and "assessment_opened" are both
 * successes and mean completely different things to the person reading them.
 */

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/session";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { parseCancellationReason } from "@/lib/disputes/validation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import type { CancelResult } from "@/lib/cancellations/types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function cancelJob(input: {
  jobId: string;
  reason: string;
}): Promise<CancelResult> {
  const context = await requireRole("client");

  if (!UUID_PATTERN.test(input.jobId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  const reason = parseCancellationReason(input.reason);

  if (!reason.ok) {
    return { ok: false, error: "Check the reason.", fieldErrors: reason.fieldErrors };
  }

  const admin = createServiceRoleClient();

  const { data, error } = await admin
    .rpc("request_job_cancellation", {
      p_job_id: input.jobId,
      p_client_id: context.user.id,
      p_reason: reason.value,
    })
    .single();

  if (error) {
    console.error(`[cancellations] request_job_cancellation ${input.jobId}: ${error.message}`);
    return { ok: false, error: "We couldn't cancel that. Try again." };
  }

  switch (data.status) {
    case "cancelled":
      break;

    case "assessment_opened":
      // Not a failure — spec §5's fourth row. The job is still standing, escrow
      // is frozen, and a person now decides. Reported as its own success so the
      // screen can send them to the case rather than to an empty dashboard.
      revalidatePath(JOB_ROUTES.dashboard);
      revalidatePath(JOB_ROUTES.review(input.jobId));
      revalidatePath(WORKER_ROUTES.work);
      revalidatePath(WORKER_ROUTES.deliver(input.jobId));

      return {
        ok: true,
        outcome: "assessed",
        disputeId: data.dispute_id,
        detail: data.detail,
      };

    case "post_delivery":
      return {
        ok: false,
        error:
          data.detail ??
          "Work has already been delivered, so there is no percentage refund on this job.",
      };

    case "already_disputed":
      return { ok: false, error: data.detail ?? "This job already has an open case." };

    case "not_cancellable":
      return { ok: false, error: data.detail ?? "This job can't be cancelled any more." };

    case "not_priced":
      // The payment and the price disagree, which is a bug on our side and not
      // something a client can fix by trying again. Nothing was changed.
      console.error(`[cancellations] ${input.jobId} is mispriced: ${data.detail}`);
      return {
        ok: false,
        error: "Something doesn't add up on this job's payment. We're on it — nothing has changed.",
      };

    case "reason_required":
      return { ok: false, fieldErrors: { reason: "Say why, in a sentence." }, error: "Check the reason." };

    case "not_found":
      return { ok: false, error: "That job doesn't exist." };

    case "forbidden":
      return { ok: false, error: "That job isn't yours." };

    // `open_dispute()`'s own refusals come back through this call untouched, so
    // its statuses are reachable here on the late tier.
    case "statement_required":
      return {
        ok: false,
        error: "Check the reason.",
        fieldErrors: { reason: data.detail ?? "Tell us a little more." },
      };

    default:
      throw new Error(`request_job_cancellation returned ${data.status}`);
  }

  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.review(input.jobId));
  revalidatePath(WORKER_ROUTES.work);
  revalidatePath(WORKER_ROUTES.deliver(input.jobId));

  return {
    ok: true,
    outcome: "cancelled",
    tier: data.tier,
    clientRefundPaise: data.client_refund_paise,
    workerPaise: data.worker_paise,
    feePaise: data.fee_paise,
  };
}
