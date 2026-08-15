"use server";

/**
 * Raising a dispute and answering one — spec §11.
 *
 * Both actions are open to *either* side, which is the first rule spec §11
 * states, so neither calls `requireRole` — a role guard here would be wrong
 * twice over. The party is worked out inside `open_dispute()` and
 * `respond_to_dispute()` from the job's own `client_id` and
 * `assigned_worker_id`, under the row lock, and someone who is neither gets
 * `forbidden` rather than a guess.
 *
 * `requireUser()` is still the gate: an anonymous caller has no business here at
 * all, and the id it returns is the only thing passed as the actor. Nothing
 * about who is acting comes from the payload.
 *
 * Raising a dispute freezes money. That is the whole reason it is a database
 * function and not three writes from here: the escrow hold, the job status and
 * the auto-accept clock have to stop together or a worker gets paid out of money
 * somebody is in the middle of contesting.
 */

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/session";
import { DISPUTE_ROUTES } from "@/lib/constants/disputes";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import type { OpenDisputeResult, RespondResult } from "@/lib/disputes/types";
import { parseDisputeReason, parseStatement } from "@/lib/disputes/validation";
import { createServiceRoleClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function raiseDispute(input: {
  jobId: string;
  reason: string;
  statement: string;
}): Promise<OpenDisputeResult> {
  const context = await requireUser();

  if (!UUID_PATTERN.test(input.jobId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  const reason = parseDisputeReason(input.reason);
  if (!reason.ok) {
    return { ok: false, error: "Check the summary.", fieldErrors: reason.fieldErrors };
  }

  const statement = parseStatement(input.statement);
  if (!statement.ok) {
    return { ok: false, error: "Check your statement.", fieldErrors: statement.fieldErrors };
  }

  const admin = createServiceRoleClient();

  const { data, error } = await admin
    .rpc("open_dispute", {
      p_job_id: input.jobId,
      p_actor_id: context.user.id,
      p_reason: reason.value,
      p_statement: statement.value,
      // No cap. Spec §5's 70% ceiling belongs to a late cancellation, and
      // `request_job_cancellation()` is the only thing that passes one — a
      // dispute raised directly is about the work, and §11 caps nothing.
    })
    .single();

  if (error) {
    console.error(`[disputes] open_dispute ${input.jobId}: ${error.message}`);
    return { ok: false, error: "We couldn't open that. Try again." };
  }

  switch (data.status) {
    case "opened":
      break;
    case "already_open":
      return { ok: false, error: data.detail ?? "There is already an open case on this job." };
    case "outside_window":
      return { ok: false, error: data.detail ?? "The window for this has closed." };
    case "reason_required":
      return {
        ok: false,
        error: "Check the summary.",
        fieldErrors: { reason: data.detail ?? "Sum it up in a line." },
      };
    case "statement_required":
      return {
        ok: false,
        error: "Check your statement.",
        fieldErrors: { statement: data.detail ?? "Tell us what happened." },
      };
    case "not_found":
      return { ok: false, error: "That job doesn't exist." };
    case "forbidden":
      return { ok: false, error: "That job isn't yours." };
    default:
      throw new Error(`open_dispute returned ${data.status}`);
  }

  if (!data.dispute_id) {
    throw new Error(`open_dispute reported success on ${input.jobId} with no case id`);
  }

  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.review(input.jobId));
  revalidatePath(WORKER_ROUTES.work);
  revalidatePath(WORKER_ROUTES.deliver(input.jobId));

  return { ok: true, disputeId: data.dispute_id };
}

/**
 * The other side's 500 characters — spec §11's 24 hours.
 *
 * The window is not enforced. What runs out at 24 hours is the *waiting*: the
 * case moves to a reviewer either way, and a statement that arrives late is
 * still worth more to them than a refusal issued on their behalf. The screen
 * says the deadline; the function records whatever turns up before a decision.
 */
export async function respondToDispute(input: {
  disputeId: string;
  statement: string;
}): Promise<RespondResult> {
  const context = await requireUser();

  if (!UUID_PATTERN.test(input.disputeId)) {
    return { ok: false, error: "That case doesn't exist." };
  }

  const statement = parseStatement(input.statement);
  if (!statement.ok) {
    return { ok: false, error: "Check your statement.", fieldErrors: statement.fieldErrors };
  }

  const admin = createServiceRoleClient();

  const { data, error } = await admin
    .rpc("respond_to_dispute", {
      p_dispute_id: input.disputeId,
      p_actor_id: context.user.id,
      p_statement: statement.value,
    })
    .single();

  if (error) {
    console.error(`[disputes] respond_to_dispute ${input.disputeId}: ${error.message}`);
    return { ok: false, error: "We couldn't send that. Try again." };
  }

  switch (data.status) {
    case "recorded":
      break;
    case "already_decided":
      return { ok: false, error: data.detail ?? "This case has already been decided." };
    case "statement_required":
      return {
        ok: false,
        error: "Check your statement.",
        fieldErrors: { statement: data.detail ?? "Tell us what happened." },
      };
    case "not_found":
      return { ok: false, error: "That case doesn't exist." };
    case "forbidden":
      return { ok: false, error: "That case isn't yours." };
    default:
      throw new Error(`respond_to_dispute returned ${data.status}`);
  }

  revalidatePath(DISPUTE_ROUTES.case(input.disputeId));

  return { ok: true };
}
