"use server";

/**
 * The approval decision (spec §6 and §7).
 *
 * Three checks stand between a click and a worker's status changing, and they
 * are deliberately not the same check three times:
 *   * `requireAdmin('review_workers')` decides whether this screen may act
 *   * `review_worker_application()` looks the permission up again from the
 *     reviewer's id, because under the service-role key `auth.uid()` is null and
 *     `admin_can()` would answer false for a super admin
 *   * the function writes the decision, the sample stamps and the audit row in
 *     one transaction, so there is no state where a worker is approved and
 *     nobody is recorded as having approved them
 *
 * A reason is required on every outcome, not just a rejection: spec §7 makes the
 * audit log permanent and mandates a reason on each entry, and "approved" with
 * no note is the entry that is useless six months later.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/admin/session";
import { type ReviewFormState, isReviewDecision } from "@/lib/admin/types";
import { ADMIN_ROUTES, WORKER_ROUTES } from "@/lib/constants/workers";
import { type KycReviewFormState, isKycReviewDecision } from "@/lib/kyc/types";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { parseIpAddress } from "@/lib/utils/validation";

const REASON_MIN_LENGTH = 3;
const REASON_MAX_LENGTH = 500;

export async function reviewWorkerApplication(
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  const context = await requireAdmin("review_workers");

  const applicationId = formData.get("applicationId");
  const decision = formData.get("decision");

  if (typeof applicationId !== "string" || !isReviewDecision(decision)) {
    return { status: "error", error: "Pick one of the three outcomes." };
  }

  const reason = asText(formData.get("reason"), REASON_MAX_LENGTH);
  const internalNote = asText(formData.get("internalNote"), REASON_MAX_LENGTH * 4);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: {
        reason:
          decision === "reject"
            ? "Say why. The worker is shown this."
            : "Note why, for the audit log.",
      },
    };
  }

  const headerList = await headers();
  const requestIp = parseIpAddress(
    headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  );

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("review_worker_application", {
      p_application_id: applicationId,
      p_reviewer_id: context.user.id,
      p_decision: decision,
      p_reason: reason,
      ...(internalNote ? { p_internal_note: internalNote } : {}),
      ...(requestIp ? { p_ip: requestIp } : {}),
    })
    .single();

  if (error) {
    throw new Error(`review_worker_application failed for ${applicationId}: ${error.message}`);
  }

  switch (data.status) {
    case "reviewed":
      break;
    case "not_submitted":
      return {
        status: "error",
        error: "Someone else has already decided this one. Reload to see the outcome.",
      };
    case "not_found":
      return { status: "error", error: "That application no longer exists." };
    case "forbidden":
      // The page guard said yes and the database said no, which means the
      // permission was revoked mid-session. Worth a log line, not a crash.
      console.error(`[admin] ${context.user.id} lost review_workers mid-review`);
      return { status: "error", error: "You no longer have permission to review workers." };
    case "reason_required":
      return { status: "error", fieldErrors: { reason: "Say why, in a few words at least." } };
    default:
      throw new Error(`review_worker_application returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.approvals);
  revalidatePath(WORKER_ROUTES.samples);

  redirect(`${ADMIN_ROUTES.approvals}?reviewed=${decision}`);
}

/**
 * The KYC decision (spec §6, §7).
 *
 * Same three checks as above, one permission along: `manage_payouts` decides
 * whether this screen may act, the `admin_can('manage_payouts')` policy decides
 * what the queue returned, and `review_worker_kyc()` looks the permission up
 * again from the reviewer's id because `auth.uid()` is null under the
 * service-role key.
 *
 * Two outcomes only, and the one that is missing is the point. There is no
 * "unblock": spec §6 gives a name mismatch no override, and the function refuses
 * a blocked row outright — so a reviewer who tries reads `blocked_no_override`
 * rather than finding a button that quietly works. The rule holds at the layer
 * where a tired support shift cannot reach around it.
 */
export async function reviewWorkerKyc(
  _previous: KycReviewFormState,
  formData: FormData,
): Promise<KycReviewFormState> {
  const context = await requireAdmin("manage_payouts");

  const workerId = formData.get("workerId");
  const decision = formData.get("decision");

  if (typeof workerId !== "string" || !isKycReviewDecision(decision)) {
    return { status: "error", error: "Pick one of the two outcomes." };
  }

  const reason = asText(formData.get("reason"), REASON_MAX_LENGTH);

  if (reason.length < REASON_MIN_LENGTH) {
    return {
      status: "error",
      fieldErrors: {
        reason:
          decision === "reject"
            ? "Say why. This is permanent and the worker is told."
            : "Note what you checked, for the audit log.",
      },
    };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("review_worker_kyc", {
      p_worker_id: workerId,
      p_reviewer_id: context.user.id,
      p_decision: decision,
      p_reason: reason,
    })
    .single();

  if (error) {
    throw new Error(`review_worker_kyc failed for ${workerId}: ${error.message}`);
  }

  switch (data.status) {
    case "reviewed":
      break;
    case "not_found":
      return { status: "error", error: "That worker has no KYC on file." };
    case "blocked_no_override":
      return {
        status: "error",
        error:
          "That account was blocked for a name mismatch, and spec §6 gives that no override — not here and not by anyone. Nothing was changed.",
      };
    case "forbidden":
      // The page guard said yes and the database said no: the permission was
      // revoked mid-session. Worth a log line, not a crash.
      console.error(`[admin] ${context.user.id} lost manage_payouts mid-review`);
      return { status: "error", error: "You no longer have permission to review payouts." };
    case "reason_required":
      return { status: "error", fieldErrors: { reason: "Say why, in a few words at least." } };
    case "invalid_decision":
      return { status: "error", error: "Pick one of the two outcomes." };
    default:
      throw new Error(`review_worker_kyc returned ${data.status}`);
  }

  revalidatePath(ADMIN_ROUTES.kyc);
  revalidatePath(WORKER_ROUTES.kyc);

  redirect(`${ADMIN_ROUTES.kyc}?reviewed=${decision}`);
}

function asText(input: FormDataEntryValue | null, maxLength: number): string {
  if (typeof input !== "string") return "";

  return input.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
