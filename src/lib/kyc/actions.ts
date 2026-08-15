"use server";

/**
 * KYC, submitted and settled — spec §6, "KYC — before first payout".
 *
 * Rules that hold everywhere below:
 *   * the worker is re-derived from the session on every call, never taken from
 *     the payload
 *   * nothing the browser sends is trusted with a consequence. The declared name
 *     is only ever a *claim*; what decides the outcome is the name the bank
 *     returns and the name the PAN registry returns, neither of which the worker
 *     can influence
 *   * the full PAN and the full account number reach Razorpay and nothing else.
 *     Storage gets four digits and a keyed HMAC — see `lib/kyc/hash.ts`
 *   * every write goes through a service-role function that owns the whole
 *     transition. INSERT and UPDATE on `worker_kyc` and `payout_methods` have
 *     been revoked from `authenticated` since 0005, precisely so a browser
 *     cannot mark its own destination verified
 *
 * ---------------------------------------------------------------------------
 * The order of operations, and why the attempt is spent first
 *
 *   open_worker_kyc_attempt()      counts the attempt, records the claim
 *   verifyPan()                    synchronous — its mismatch blocks immediately
 *   createFundAccountValidation()  asynchronous — starts the penny drop
 *   record_worker_kyc_destination() the destination, held `verifying`
 *   settle_worker_kyc()            whenever the bank answers
 *
 * The attempt is counted before a single rupee is spent on a penny drop, so a
 * worker who closes the tab mid-verification has still used one. Spec §6's
 * three-attempt ceiling is an anti-abuse limit on a call that costs real money;
 * a ceiling that can be escaped by abandoning the request is not one.
 *
 * ---------------------------------------------------------------------------
 * Blocked, and the one place it is decided
 *
 * Spec §6: "name mismatch = blocked, no override." Every name that arrives is
 * compared with every other — declared against bank, declared against PAN, and
 * bank against PAN, which is the pair that catches an account and a PAN
 * belonging to two different people. The lowest of those agreements is the
 * score, it is written to `worker_kyc.name_match_score` beside the decision it
 * made, and below the threshold the account is blocked permanently.
 * `review_worker_kyc()` refuses to lift it. That is what makes "no override" a
 * property of the system rather than a promise.
 */

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/session";
import { NAME_MATCH_MIN_SCORE } from "@/lib/constants/kyc";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { isKycConfigured, isPanVerificationConfigured } from "@/lib/env";
import {
  bankDestinationHash,
  panHash as hashPan,
  upiDestinationHash,
} from "@/lib/kyc/hash";
import { lowestPairScore, roundScore } from "@/lib/kyc/names";
import {
  type Destination,
  type FundAccountValidation,
  createFundAccountValidation,
  fetchFundAccountValidation,
  verifyPan,
} from "@/lib/kyc/razorpay";
import type { KycActionResult, KycFieldErrors, KycSubmission } from "@/lib/kyc/types";
import {
  bankLabel,
  lastFour,
  maskUpi,
  parseAccountNumber,
  parseDateOfBirth,
  parseIfsc,
  parseLegalName,
  parsePan,
  parseUpiId,
} from "@/lib/kyc/validation";
import { RazorpayError } from "@/lib/payments/razorpay";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

type AdminSupabaseClient = ReturnType<typeof createServiceRoleClient>;

const UNAVAILABLE =
  "Bank verification isn't switched on yet. Your earnings keep rolling into the next cycle — nothing expires.";

function refreshScreens(): void {
  revalidatePath(WORKER_ROUTES.kyc);
  revalidatePath(WORKER_ROUTES.earnings);
}

/**
 * The threshold, read from `platform_settings` so it can be moved without a
 * deploy. Falls back to the constant rather than failing the verification: a
 * missing setting must never be the reason someone is or is not paid, and the
 * two are the same number until an admin changes one.
 */
async function nameMatchThreshold(admin: AdminSupabaseClient): Promise<number> {
  const { data, error } = await admin
    .from("platform_settings")
    .select("value")
    .eq("key", "kyc.name_match_min_bps")
    .maybeSingle();

  if (error || !data) return NAME_MATCH_MIN_SCORE;

  const bps = Number(data.value);

  return Number.isFinite(bps) && bps > 0 && bps <= 10_000
    ? bps / 10_000
    : NAME_MATCH_MIN_SCORE;
}

/**
 * The names, compared, and the row settled on what they say.
 *
 * Shared by the submit path and the refresh path because there is exactly one
 * definition of "this worker is verified" and it must not exist twice. Every
 * branch below ends in `settle_worker_kyc()`; the function is idempotent, so two
 * of these racing on the same row produce one outcome.
 */
async function settleAgainst({
  admin,
  workerId,
  declaredName,
  panRegisteredName,
  validation,
}: {
  admin: AdminSupabaseClient;
  workerId: string;
  declaredName: string;
  panRegisteredName: string | null;
  validation: FundAccountValidation;
}): Promise<KycActionResult> {
  if (validation.status === "created") {
    return {
      ok: true,
      status: "verifying",
      message:
        "We've sent ₹1 to that account to confirm the name on it. This usually takes a couple of minutes.",
    };
  }

  if (validation.status === "failed") {
    return settle(admin, workerId, {
      outcome: "failed",
      failureCode: "penny_drop_failed",
      reason: validation.failureReason ?? "The bank could not confirm that account.",
      panRegisteredName,
    });
  }

  if (validation.accountStatus !== null && validation.accountStatus !== "active") {
    return settle(admin, workerId, {
      outcome: "failed",
      failureCode: `account_${validation.accountStatus}`,
      reason: "That account came back as unusable. Check the number and the IFSC.",
      panRegisteredName,
      pennyDropName: validation.registeredName,
    });
  }

  // Completed, active, and no name. Nothing to compare, so nothing to pass:
  // treating a silent bank as a match is exactly the hole spec §6 closes.
  if (validation.registeredName === null) {
    return settle(admin, workerId, {
      outcome: "failed",
      failureCode: "no_registered_name",
      reason: "The bank confirmed the account but didn't return a name on it.",
      panRegisteredName,
    });
  }

  const threshold = await nameMatchThreshold(admin);
  const score = lowestPairScore([declaredName, validation.registeredName, panRegisteredName]);

  // Null means fewer than two names arrived, which cannot happen here — the
  // declared name and the bank's are both present by this point. Treated as a
  // failure rather than a pass anyway, because the alternative is a branch that
  // verifies someone when an assumption stops holding.
  if (score === null) {
    return settle(admin, workerId, {
      outcome: "failed",
      failureCode: "no_names_to_compare",
      reason: "We couldn't compare the names on that account.",
      panRegisteredName,
      pennyDropName: validation.registeredName,
    });
  }

  const rounded = roundScore(score);

  if (rounded < threshold) {
    return settle(admin, workerId, {
      outcome: "blocked",
      failureCode: "name_mismatch",
      reason:
        `The name on that account is "${validation.registeredName}", which isn't the name ` +
        `on this profile.` +
        (validation.providerNameMatch !== null
          ? ` Razorpay scored the match ${validation.providerNameMatch}/100.`
          : ""),
      score: rounded,
      panRegisteredName,
      pennyDropName: validation.registeredName,
    });
  }

  return settle(admin, workerId, {
    outcome: "verified",
    score: rounded,
    panRegisteredName,
    pennyDropName: validation.registeredName,
  });
}

/** One call into `settle_worker_kyc()`, one place that turns its answer into a
 *  sentence. Every branch above ends here. */
async function settle(
  admin: AdminSupabaseClient,
  workerId: string,
  input: {
    outcome: "verified" | "blocked" | "failed";
    reason?: string;
    failureCode?: string;
    score?: number;
    pennyDropName?: string | null;
    panRegisteredName?: string | null;
  },
): Promise<KycActionResult> {
  const { data, error } = await admin
    .rpc("settle_worker_kyc", {
      p_worker_id: workerId,
      p_outcome: input.outcome,
      ...(input.pennyDropName ? { p_penny_drop_name: input.pennyDropName } : {}),
      ...(input.panRegisteredName
        ? { p_pan_registered_name: input.panRegisteredName }
        : {}),
      ...(input.score !== undefined ? { p_name_match_score: input.score } : {}),
      ...(input.reason ? { p_reason: input.reason } : {}),
      ...(input.failureCode ? { p_failure_code: input.failureCode } : {}),
    })
    .single();

  if (error) {
    throw new Error(`settle_worker_kyc failed for ${workerId}: ${error.message}`);
  }

  refreshScreens();

  if (data.status === "not_found") {
    return { ok: false, error: "We couldn't find your verification. Start it again." };
  }

  if (data.kyc_status === "verified") {
    return {
      ok: true,
      status: "verified",
      message: "Verified. Your next payout will go to this account.",
    };
  }

  if (data.kyc_status === "blocked") {
    return {
      ok: false,
      error:
        (data.detail ?? "The name on that account isn't the name on this profile.") +
        " We can't verify this account, and this can't be overridden. Write to support if you think it's wrong.",
    };
  }

  return {
    ok: false,
    error: data.in_review
      ? `${data.detail ?? "That didn't go through."} That was your last attempt — someone will look at it and get back to you.`
      : `${data.detail ?? "That didn't go through."} ${data.attempts_left} ${
          data.attempts_left === 1 ? "attempt" : "attempts"
        } left.`,
  };
}

/** Razorpay's own words are for the log; the worker gets the sentence. */
function describeRazorpayFailure(error: unknown, scope: string): string {
  if (error instanceof RazorpayError) {
    console.error(`[kyc] ${scope} failed (${error.status}/${error.code}): ${error.message}`);

    return error.retryable
      ? "We couldn't reach the bank just then. Try again in a minute."
      : "That account was refused. Check the details and try again.";
  }

  console.error(`[kyc] ${scope} failed:`, error);
  return "Something went wrong on our side. Try again.";
}

export async function submitWorkerKyc(input: KycSubmission): Promise<KycActionResult> {
  const context = await requireRole("worker");

  if (!isKycConfigured()) return { ok: false, error: UNAVAILABLE };

  // ---- what the worker typed ------------------------------------------------

  const fieldErrors: KycFieldErrors = {};

  const legalName = parseLegalName(input.legalName);
  if (!legalName.ok) fieldErrors.legalName = legalName.error;

  const dateOfBirth = parseDateOfBirth(input.dateOfBirth);
  if (!dateOfBirth.ok) fieldErrors.dateOfBirth = dateOfBirth.error;

  const wantsBank = input.methodType === "bank_account";

  const ifsc = wantsBank ? parseIfsc(input.ifsc) : null;
  if (ifsc && !ifsc.ok) fieldErrors.ifsc = ifsc.error;

  const accountNumber = wantsBank ? parseAccountNumber(input.accountNumber) : null;
  if (accountNumber && !accountNumber.ok) fieldErrors.accountNumber = accountNumber.error;

  const upiId = wantsBank ? null : parseUpiId(input.upiId);
  if (upiId && !upiId.ok) fieldErrors.upiId = upiId.error;

  // Optional here, and the database decides whether it was: spec §6 makes PAN
  // mandatory only above ₹5,000 lifetime, and that figure is not the browser's
  // to assert.
  const supplied = input.pan.trim().length > 0;
  const pan = supplied ? parsePan(input.pan) : null;
  if (pan && !pan.ok) fieldErrors.pan = pan.error;

  // A PAN that cannot be checked is not recorded. Spec §6 wants the registry's
  // name compared, and a stored-but-unverified PAN would sit on the row looking
  // like it had been.
  if (supplied && pan?.ok && !isPanVerificationConfigured()) {
    fieldErrors.pan =
      "We can't check a PAN yet. Leave it blank for now — it's only required once you've earned ₹5,000.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: "Check the fields marked below.", fieldErrors };
  }

  if (!legalName.ok || !dateOfBirth.ok) {
    // Unreachable — both were folded into `fieldErrors` above. Here so the
    // narrowing below is the compiler's conclusion rather than an assertion.
    return { ok: false, error: "Check the fields marked below.", fieldErrors };
  }

  const destination: Destination = wantsBank
    ? {
        kind: "bank_account",
        accountNumber: accountNumber?.ok ? accountNumber.value : "",
        ifsc: ifsc?.ok ? ifsc.value : "",
      }
    : { kind: "upi", vpa: upiId?.ok ? upiId.value : "" };

  const panValue = pan?.ok ? pan.value : null;
  const admin = createServiceRoleClient();

  // ---- the attempt ----------------------------------------------------------

  const { data: opened, error: openError } = await admin
    .rpc("open_worker_kyc_attempt", {
      p_worker_id: context.user.id,
      p_legal_name: legalName.value,
      p_dob: dateOfBirth.value,
      ...(panValue ? { p_pan_hash: hashPan(panValue), p_pan_last4: panValue.slice(-4) } : {}),
    })
    .single();

  if (openError) {
    throw new Error(
      `open_worker_kyc_attempt failed for ${context.user.id}: ${openError.message}`,
    );
  }

  switch (opened.status) {
    case "opened":
      break;
    case "not_a_worker":
      return { ok: false, error: "This account isn't set up as a worker." };
    case "already_verified":
      return { ok: true, status: "verified", message: "You're already verified." };
    case "blocked":
      return {
        ok: false,
        error: `${opened.detail ?? "This account is blocked for verification."} This can't be overridden.`,
      };
    case "in_progress":
      return {
        ok: true,
        status: "verifying",
        message: "We're still checking the account you sent. Give it a moment.",
      };
    case "in_review":
      return {
        ok: false,
        error:
          "You've used all your attempts. Someone is looking at it and will get back to you.",
      };
    case "pan_required":
      return {
        ok: false,
        error: isPanVerificationConfigured()
          ? "You've earned over ₹5,000, so we need your PAN for TDS."
          : "You've earned over ₹5,000, so PAN is required — and we can't check one yet. Write to support.",
        fieldErrors: { pan: "Required once you've earned ₹5,000." },
      };
    default:
      throw new Error(`open_worker_kyc_attempt returned ${opened.status}`);
  }

  // ---- the PAN registry -----------------------------------------------------
  //
  // Before the penny drop, because it is synchronous and a mismatch here ends
  // the attempt without spending one on a bank call.

  let panRegisteredName: string | null = null;

  if (panValue) {
    try {
      const checked = await verifyPan({ pan: panValue, declaredName: legalName.value });

      if (!checked.found) {
        return settle(admin, context.user.id, {
          outcome: "failed",
          failureCode: "pan_not_found",
          reason: checked.detail ?? "That PAN wasn't found. Check the ten characters.",
        });
      }

      panRegisteredName = checked.registeredName;

      const threshold = await nameMatchThreshold(admin);
      const panScore = lowestPairScore([legalName.value, panRegisteredName]);

      if (panScore !== null && roundScore(panScore) < threshold) {
        return settle(admin, context.user.id, {
          outcome: "blocked",
          failureCode: "name_mismatch",
          reason: `That PAN is registered to "${panRegisteredName}", which isn't the name on this profile.`,
          score: roundScore(panScore),
          panRegisteredName,
        });
      }
    } catch (error) {
      return settle(admin, context.user.id, {
        outcome: "failed",
        failureCode: "pan_unavailable",
        reason: describeRazorpayFailure(error, "PAN verification"),
      });
    }
  }

  // ---- the penny drop -------------------------------------------------------

  let validation: FundAccountValidation;

  try {
    validation = await createFundAccountValidation({
      referenceId: context.user.id,
      declaredName: legalName.value,
      destination,
      contact: { email: context.profile.email, mobile: context.profile.mobile },
    });
  } catch (error) {
    return settle(admin, context.user.id, {
      outcome: "failed",
      failureCode: "penny_drop_refused",
      reason: describeRazorpayFailure(error, "penny drop"),
      panRegisteredName,
    });
  }

  // ---- the destination, on file and pending ---------------------------------

  const { error: destinationError } = await admin.rpc("record_worker_kyc_destination", {
    p_worker_id: context.user.id,
    p_method_type: input.methodType,
    p_destination_hash:
      destination.kind === "bank_account"
        ? bankDestinationHash(destination.accountNumber, destination.ifsc)
        : upiDestinationHash(destination.vpa),
    p_provider_reference: validation.id,
    ...(destination.kind === "bank_account"
      ? {
          p_ifsc: destination.ifsc,
          p_account_last4: lastFour(destination.accountNumber),
          p_label: bankLabel(destination.ifsc, lastFour(destination.accountNumber)),
        }
      : {
          p_upi_masked: maskUpi(destination.vpa),
          p_label: maskUpi(destination.vpa),
        }),
    ...(validation.bankName ? { p_bank_name: validation.bankName } : {}),
    ...(validation.fundAccountId ? { p_fund_account_id: validation.fundAccountId } : {}),
    ...(validation.contactId ? { p_contact_id: validation.contactId } : {}),
  });

  if (destinationError) {
    throw new Error(
      `record_worker_kyc_destination failed for ${context.user.id}: ${destinationError.message}`,
    );
  }

  refreshScreens();

  return settleAgainst({
    admin,
    workerId: context.user.id,
    declaredName: legalName.value,
    panRegisteredName,
    validation,
  });
}

/**
 * Read the penny drop back and settle on it.
 *
 * Called once when the KYC screen mounts with a validation in flight, and again
 * whenever the worker asks. That is the whole of the async story: Razorpay
 * answers in seconds to minutes, the worker is on a page that asks when they
 * open it, and the row is idempotent so being asked twice costs nothing.
 *
 * A worker who never comes back keeps a `verifying` row, and their earnings keep
 * rolling forward exactly as spec §6's "anything short rolls forward" describes.
 * The console's KYC queue is where that becomes someone's problem rather than
 * nobody's — a validation stuck in `verifying` is one of the three reasons a row
 * appears there.
 */
export async function refreshWorkerKyc(): Promise<KycActionResult> {
  const context = await requireRole("worker");

  if (!isKycConfigured()) return { ok: false, error: UNAVAILABLE };

  const supabase = await createClient();

  const { data: row, error } = await supabase
    .from("worker_kyc")
    .select("status, legal_name, pan_registered_name, provider_reference")
    .eq("worker_id", context.user.id)
    .maybeSingle();

  if (error) throw new Error(`could not read KYC: ${error.message}`);

  if (!row || row.status !== "verifying" || !row.provider_reference || !row.legal_name) {
    return { ok: false, error: "There's nothing in flight to check." };
  }

  let validation: FundAccountValidation;

  try {
    validation = await fetchFundAccountValidation(row.provider_reference);
  } catch (error) {
    return { ok: false, error: describeRazorpayFailure(error, "reading the penny drop") };
  }

  return settleAgainst({
    admin: createServiceRoleClient(),
    workerId: context.user.id,
    declaredName: row.legal_name,
    panRegisteredName: row.pan_registered_name,
    validation,
  });
}
