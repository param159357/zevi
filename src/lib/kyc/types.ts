/**
 * The shapes the KYC screen and the console's KYC queue read.
 *
 * Kept out of the query and action modules for the same reason every other
 * feature here does it, and out of `names.ts`, which stays a pure comparison of
 * two strings and should not learn about payout destinations.
 */

import type { Database } from "@/types/database.types";

export type KycStatus = Database["public"]["Enums"]["kyc_status"];
export type PayoutMethodType = Database["public"]["Enums"]["payout_method_type"];
export type PayoutMethodStatus = Database["public"]["Enums"]["payout_method_status"];

export type KycFieldErrors = Partial<
  Record<"legalName" | "dateOfBirth" | "pan" | "ifsc" | "accountNumber" | "upiId", string>
>;

/**
 * What the form sends. The destination is one or the other, never both: spec §6
 * lists "Bank + IFSC, or UPI ID" and a worker with two destinations is a worker
 * one of whose accounts was never penny-dropped.
 */
export type KycSubmission = {
  legalName: string;
  dateOfBirth: string;
  /** Optional under ₹5,000 lifetime, where spec §6 says UPI alone is enough. */
  pan: string;
  methodType: PayoutMethodType;
  ifsc: string;
  accountNumber: string;
  upiId: string;
};

export type KycActionResult =
  | { ok: true; status: KycStatus; message: string }
  | { ok: false; error: string; fieldErrors?: KycFieldErrors };

/** The destination on file, as much of it as anyone is allowed to see. */
export type PayoutDestination = {
  id: string;
  type: PayoutMethodType;
  status: PayoutMethodStatus;
  label: string | null;
  bankName: string | null;
  ifsc: string | null;
  accountLast4: string | null;
  upiMasked: string | null;
  verifiedAt: string | null;
};

/**
 * Everything the KYC screen needs to decide what to render, in one read.
 *
 * `canSubmit` and `panRequired` are answers, not raw columns, because both are
 * decided in three places — here for the form, in `submitWorkerKyc` for the
 * request, and in `open_worker_kyc_attempt()` for the row — and the screen
 * should be reading the same sentence the other two enforce.
 */
export type KycOverview = {
  status: KycStatus;
  legalName: string | null;
  dateOfBirth: string | null;
  panLast4: string | null;
  attempts: number;
  attemptsLeft: number;
  /** Set only on `blocked`. Spec §6 gives a name mismatch no override, so this
   *  is the last thing the worker is ever told about it. */
  blockedReason: string | null;
  lastFailureReason: string | null;
  nameMatchScore: number | null;
  pennyDropName: string | null;
  panRegisteredName: string | null;
  duplicatePanFlagged: boolean;
  submittedAt: string | null;
  verifiedAt: string | null;
  destination: PayoutDestination | null;
  /** Net earnings that have not been reversed — what the ₹5,000 line is drawn
   *  against (spec §6). */
  lifetimeEarningsPaise: number;
  panRequired: boolean;
  /** False while an attempt is in flight, once verified, once blocked, and once
   *  the attempt ceiling is spent. */
  canSubmit: boolean;
  /** Whether the platform can run a penny drop at all right now. */
  configured: boolean;
  /** Whether a PAN can be checked. Under the ₹5,000 line, KYC completes without
   *  one; above it, this being false is what stops the worker. */
  panVerificationAvailable: boolean;
};

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

/** Why a row is in front of an admin. Spec §6 names two of these; the third is
 *  a validation that never came back. */
export type KycAttentionReason = "attempts_spent" | "duplicate_pan" | "stuck_verifying";

export type KycQueueRow = {
  workerId: string;
  displayName: string;
  legalName: string | null;
  status: KycStatus;
  attempts: number;
  duplicatePanFlagged: boolean;
  panLast4: string | null;
  lastFailureReason: string | null;
  nameMatchScore: number | null;
  pennyDropName: string | null;
  panRegisteredName: string | null;
  submittedAt: string | null;
  updatedAt: string;
  reasons: KycAttentionReason[];
};

export type KycReviewDecision = "allow_retry" | "reject";

export function isKycReviewDecision(input: unknown): input is KycReviewDecision {
  return input === "allow_retry" || input === "reject";
}

export type KycReviewFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: { reason?: string };
};
