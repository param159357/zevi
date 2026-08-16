"use server";

/**
 * The three decisions the console's new modules make (spec §7).
 *
 *   resolveDispute()      release · refund · split, with a required note
 *   sanctionUser()        warn · suspend · ban
 *   liftSanction()        the way back from the two that restrict
 *   reviewPayoutBatch()   approve a batch for the run, or unbuild it
 *   retryFailedPayout()   return a failed payout to the next cycle
 *
 * Each one is the same three checks 0027 and 0033 established, and they are
 * deliberately not the same check three times:
 *
 *   * `requireAdmin(perm)` decides whether this screen may act at all
 *   * the `admin_can(...)` policies decided what the query that rendered the
 *     screen was allowed to return
 *   * the database function looks the permission up **again**, from the actor's
 *     id, because under the service-role key `auth.uid()` is null and
 *     `admin_can()` would answer false for a super admin
 *
 * And each one writes `admin_audit_log` inside the same transaction as its
 * effect, so there is no state where money moved or an account was banned and
 * nobody is recorded as having done it. Spec §7 makes that log permanent; the
 * append-only trigger on the table is what makes "permanent" true rather than
 * intended.
 *
 * Nothing here computes an amount. `resolve_dispute()` takes a share in basis
 * points and reads every rupee off the frozen `job_financials` row, exactly as
 * `settle_job_payment_and_assign()` and `accept_job_delivery()` do — there is no
 * number in any of these signatures for a browser to lie about.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/session";
import {
  type DisputeFormState,
  type PayoutFormState,
  type SanctionFormState,
  isDisputeOutcome,
  isSanctionType,
} from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { notifyDisputeUpdate } from "@/lib/email/events";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { parseIpAddress } from "@/lib/utils/validation";

/** Mirrors `disputes_decision_has_note`. Spec §7 requires the note; the column
 *  requires ten characters of it. */
const NOTE_MIN_LENGTH = 10;
const NOTE_MAX_LENGTH = 2000;
const REASON_MIN_LENGTH = 3;
const REASON_MAX_LENGTH = 500;

/** Suspensions are measured in whole days, and an unbounded one is a ban by
 *  another name — so the field is capped rather than left open. */
const MAX_SUSPENSION_DAYS = 365;

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

/**
 * Spec §11's three outcomes, and no fourth.
 *
 * The split share arrives as a percentage the reviewer typed and is converted
 * to basis points here, because the column is bps and the screen is not: asking
 * a person to type 6000 to mean 60% is how a client gets 6% of their money back
 * at four in the afternoon.
 */
export async function resolveDispute(
  _previous: DisputeFormState,
  formData: FormData,
): Promise<DisputeFormState> {
  const context = await requireAdmin("resolve_disputes");

  const disputeId = formData.get("disputeId");
  const outcome = formData.get("outcome");

  if (typeof disputeId !== "string" || !isDisputeOutcome(outcome)) {
    return { status: "error", error: "Pick one of the three outcomes." };
  }

  const note = asText(formData.get("decisionNote"), NOTE_MAX_LENGTH);

  if (note.length < NOTE_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: {
        decisionNote: `Say why, in at least ${NOTE_MIN_LENGTH} characters. This is permanent and both sides' histories are read against it.`,
      },
    };
  }

  let splitClientBps: number | null = null;

  if (outcome === "split") {
    const percent = Number(formData.get("clientPercent"));

    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return {
        status: "error",
        fieldErrors: { clientPercent: "Give the client's share as a percentage, 0 to 100." },
      };
    }

    // Whole percents only. A split of 33.5% is a number nobody can defend in a
    // sentence, and the column stores bps so the rounding would be silent.
    splitClientBps = Math.round(percent) * 100;
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("resolve_dispute", {
      p_dispute_id: disputeId,
      p_admin_id: context.user.id,
      p_outcome: outcome,
      p_decision_note: note,
      ...(splitClientBps === null ? {} : { p_split_client_bps: splitClientBps }),
      ...(await requestIp()),
    })
    .single();

  if (error) throw new Error(`resolve_dispute failed for ${disputeId}: ${error.message}`);

  switch (data.status) {
    case "resolved":
      break;
    case "not_found":
      return { status: "error", error: "That dispute no longer exists." };
    case "already_decided":
      return {
        status: "error",
        error: "Someone else has already decided this one. Reload to see the outcome.",
      };
    case "escrow_settled":
      return { status: "error", error: data.detail ?? "There is nothing left in escrow to divide." };
    case "over_cap":
      // Spec §5's 70% ceiling on a late cancellation. The form takes the
      // forbidden outcomes off the screen, so reaching this means the cap was
      // set after the page rendered, or the post came from somewhere else.
      return {
        status: "error",
        error: data.detail ?? "That would give the client more than this case allows.",
      };
    case "not_priced":
      return { status: "error", error: data.detail ?? "This job has no frozen price." };
    case "note_required":
      return { status: "error", fieldErrors: { decisionNote: "Say why, in a few words at least." } };
    case "split_share_required":
      return {
        status: "error",
        fieldErrors: { clientPercent: "A split needs the client's share." },
      };
    case "invalid_outcome":
      return { status: "error", error: "Pick one of the three outcomes." };
    case "forbidden":
      // The page guard said yes and the database said no: the permission was
      // revoked mid-session. Worth a log line, not a crash.
      console.error(`[admin] ${context.user.id} lost resolve_disputes mid-decision`);
      return { status: "error", error: "You no longer have permission to resolve disputes." };
    default:
      throw new Error(`resolve_dispute returned ${data.status}`);
  }

  // Both sides, before the redirect throws. The decision note is not carried:
  // spec §7 makes it mandatory and internal, and the case screen shows each
  // party their own outcome.
  await notifyDisputeUpdate({ disputeId, stage: "resolved" });

  revalidatePath(ADMIN_ROUTES.disputes);
  revalidatePath(ADMIN_ROUTES.dispute(disputeId));

  redirect(`${ADMIN_ROUTES.disputes}?decided=${outcome}`);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Spec §7: "Warn · suspend · ban. Every action logged with reason." */
export async function sanctionUser(
  _previous: SanctionFormState,
  formData: FormData,
): Promise<SanctionFormState> {
  const context = await requireAdmin("manage_users");

  const profileId = formData.get("profileId");
  const type = formData.get("type");

  if (typeof profileId !== "string" || !isSanctionType(type)) {
    return { status: "error", error: "Pick one of the three." };
  }

  const reason = asText(formData.get("reason"), REASON_MAX_LENGTH);
  const internalNote = asText(formData.get("internalNote"), NOTE_MAX_LENGTH);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: {
        reason:
          type === "warning"
            ? "Say what the warning is for. They are shown this."
            : "Say why. They are shown this, and it is in the audit log for good.",
      },
    };
  }

  let durationDays: number | null = null;

  if (type === "suspension") {
    const raw = formData.get("durationDays");

    // Blank means indefinite, which `apply_user_sanction()` reads as a null
    // `ends_at` — suspended until someone lifts it. Deliberately possible: a
    // fraud investigation has no known end date on the day it opens.
    if (typeof raw === "string" && raw.trim() !== "") {
      const days = Number(raw);

      if (!Number.isInteger(days) || days < 1 || days > MAX_SUSPENSION_DAYS) {
        return {
          status: "error",
          fieldErrors: {
            durationDays: `Whole days, 1 to ${MAX_SUSPENSION_DAYS}. Leave it blank to suspend until you lift it.`,
          },
        };
      }

      durationDays = days;
    }
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("apply_user_sanction", {
      p_profile_id: profileId,
      p_admin_id: context.user.id,
      p_type: type,
      p_reason: reason,
      ...(internalNote ? { p_internal_note: internalNote } : {}),
      ...(durationDays === null ? {} : { p_duration_days: durationDays }),
      ...(await requestIp()),
    })
    .single();

  if (error) throw new Error(`apply_user_sanction failed for ${profileId}: ${error.message}`);

  switch (data.status) {
    case "applied":
      break;
    case "not_found":
      return { status: "error", error: "That account no longer exists." };
    case "target_is_admin":
      return { status: "error", error: data.detail ?? "That account is a console member." };
    case "invalid_type":
      return { status: "error", error: data.detail ?? "Pick one of the three." };
    case "reason_required":
      return { status: "error", fieldErrors: { reason: "Say why, in a few words at least." } };
    case "forbidden":
      console.error(`[admin] ${context.user.id} lost manage_users mid-action`);
      return { status: "error", error: "You no longer have permission to manage users." };
    default:
      throw new Error(`apply_user_sanction returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.user(profileId));

  redirect(`${ADMIN_ROUTES.user(profileId)}?applied=${type}`);
}

export async function liftSanction(
  _previous: SanctionFormState,
  formData: FormData,
): Promise<SanctionFormState> {
  const context = await requireAdmin("manage_users");

  const sanctionId = formData.get("sanctionId");
  const profileId = formData.get("profileId");

  if (typeof sanctionId !== "string" || typeof profileId !== "string") {
    return { status: "error", error: "That sanction could not be identified." };
  }

  const reason = asText(formData.get("liftReason"), REASON_MAX_LENGTH);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: { liftReason: "Say why it is being lifted. It goes in the audit log." },
    };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("lift_user_sanction", {
      p_sanction_id: sanctionId,
      p_admin_id: context.user.id,
      p_reason: reason,
      ...(await requestIp()),
    })
    .single();

  if (error) throw new Error(`lift_user_sanction failed for ${sanctionId}: ${error.message}`);

  switch (data.status) {
    case "lifted":
      break;
    case "not_found":
      return { status: "error", error: "That sanction no longer exists." };
    case "already_lifted":
      return { status: "error", error: "That one has already been lifted." };
    case "reason_required":
      return { status: "error", fieldErrors: { liftReason: "Say why, in a few words at least." } };
    case "forbidden":
      console.error(`[admin] ${context.user.id} lost manage_users mid-action`);
      return { status: "error", error: "You no longer have permission to manage users." };
    default:
      throw new Error(`lift_user_sanction returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.user(profileId));

  redirect(`${ADMIN_ROUTES.user(profileId)}?applied=lifted`);
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

/**
 * Spec §7's "batch review before each run".
 *
 * Approving moves the batch `closed → under_review`, which is where the
 * disbursement step will pick it up. That step does not exist, so approving
 * today means "a person has read this and it is right" and nothing more — which
 * is exactly what the review is, and the screen says so rather than implying
 * money is about to move.
 */
export async function reviewPayoutBatch(
  _previous: PayoutFormState,
  formData: FormData,
): Promise<PayoutFormState> {
  const context = await requireAdmin("manage_payouts");

  const batchId = formData.get("batchId");
  const decision = formData.get("decision");

  if (typeof batchId !== "string" || (decision !== "approve" && decision !== "cancel")) {
    return { status: "error", error: "Pick approve or cancel." };
  }

  const reason = asText(formData.get("reason"), REASON_MAX_LENGTH);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: {
        reason:
          decision === "approve"
            ? "Note what you checked. It goes in the audit log."
            : "Say why this batch is being unbuilt.",
      },
    };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("review_payout_batch", {
      p_batch_id: batchId,
      p_admin_id: context.user.id,
      p_decision: decision,
      p_reason: reason,
      ...(await requestIp()),
    })
    .single();

  if (error) throw new Error(`review_payout_batch failed for ${batchId}: ${error.message}`);

  switch (data.status) {
    case "reviewed":
      break;
    case "not_found":
      return { status: "error", error: "That batch no longer exists." };
    case "not_reviewable":
      return { status: "error", error: data.detail ?? "That batch cannot be reviewed." };
    case "reason_required":
      return { status: "error", fieldErrors: { reason: "Say why, in a few words at least." } };
    case "invalid_decision":
      return { status: "error", error: "Pick approve or cancel." };
    case "forbidden":
      console.error(`[admin] ${context.user.id} lost manage_payouts mid-review`);
      return { status: "error", error: "You no longer have permission to review payouts." };
    default:
      throw new Error(`review_payout_batch returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.payouts);
  revalidatePath(ADMIN_ROUTES.payoutBatch(batchId));

  redirect(`${ADMIN_ROUTES.payoutBatch(batchId)}?reviewed=${decision}`);
}

/**
 * Spec §14: "money returns to escrow … auto-retry next cycle once details
 * change."
 *
 * The retry is not a second attempt at this payout row — it is the earnings
 * going back to `confirmed`, where `build_payout_batch()` finds them on the next
 * cycle. That is what gives the retry the KYC gate for free: a worker whose
 * destination is still wrong is skipped again rather than paid again.
 */
export async function retryFailedPayout(
  _previous: PayoutFormState,
  formData: FormData,
): Promise<PayoutFormState> {
  const context = await requireAdmin("manage_payouts");

  const payoutId = formData.get("payoutId");

  if (typeof payoutId !== "string") {
    return { status: "error", error: "That payout could not be identified." };
  }

  const reason = asText(formData.get("reason"), REASON_MAX_LENGTH);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: { reason: "Say what was fixed. It goes in the audit log." },
    };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("retry_failed_payout", {
      p_payout_id: payoutId,
      p_admin_id: context.user.id,
      p_reason: reason,
      ...(await requestIp()),
    })
    .single();

  if (error) throw new Error(`retry_failed_payout failed for ${payoutId}: ${error.message}`);

  switch (data.status) {
    case "returned":
      break;
    case "not_found":
      return { status: "error", error: "That payout no longer exists." };
    case "not_failed":
      return { status: "error", error: data.detail ?? "Only a failed payout returns to the cycle." };
    case "reason_required":
      return { status: "error", fieldErrors: { reason: "Say why, in a few words at least." } };
    case "forbidden":
      console.error(`[admin] ${context.user.id} lost manage_payouts mid-retry`);
      return { status: "error", error: "You no longer have permission to manage payouts." };
    default:
      throw new Error(`retry_failed_payout returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.payouts);

  redirect(`${ADMIN_ROUTES.payouts}?retried=1`);
}

// ---------------------------------------------------------------------------

/** The generator types an optional argument as `string?`, never `string | null`,
 *  so "no value" is an omitted key and the function's own default applies. */
async function requestIp(): Promise<{ p_ip?: string }> {
  const headerList = await headers();
  const ip = parseIpAddress(
    headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  );

  return ip ? { p_ip: ip } : {};
}

function asText(input: FormDataEntryValue | null, maxLength: number): string {
  if (typeof input !== "string") return "";

  return input.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
