/**
 * Server-side reads for the KYC screen — spec §6, "KYC — before first payout".
 *
 * Every query here runs under the worker's own Supabase client, so RLS is what
 * scopes it: "workers read their own KYC" and "workers read their own payout
 * methods" (migration 0005) return nothing to anyone else. The `worker_id`
 * filters below make the intent readable; they are not what enforces it.
 *
 * Nothing here decides anything. The ₹5,000 line is drawn by
 * `worker_lifetime_earnings_paise()` inside `open_worker_kyc_attempt()`, and the
 * sum below is the same sum computed for the sentence on the form — the same
 * arrangement as the opt-in cap, where "the pre-check exists for the sentence;
 * the trigger is the limit".
 */

import {
  KYC_MAX_ATTEMPTS,
  PAN_REQUIRED_ABOVE_PAISE,
} from "@/lib/constants/kyc";
import { isKycConfigured, isPanVerificationConfigured } from "@/lib/env";
import type { KycOverview, PayoutDestination } from "@/lib/kyc/types";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const KYC_COLUMNS = `
  status, legal_name, date_of_birth, pan_last4, attempts, blocked_reason,
  last_failure_reason, name_match_score, penny_drop_name, pan_registered_name,
  duplicate_pan_flagged, submitted_at, verified_at, pending_method_id
`;

const METHOD_COLUMNS = `
  id, type, status, label, bank_name, ifsc, account_last4, upi_handle_masked,
  verified_at, disabled_at, created_at
`;

/**
 * The empty state, for a worker who has never opened the screen.
 *
 * `worker_kyc` has no row until the first attempt — spec §6 is explicit that
 * this is not a signup step, so a worker who never reaches a payout never gets
 * one — and this is what that absence looks like to the page.
 */
function emptyOverview(
  lifetimeEarningsPaise: number,
  configured: boolean,
  panAvailable: boolean,
): KycOverview {
  return {
    status: "not_started",
    legalName: null,
    dateOfBirth: null,
    panLast4: null,
    attempts: 0,
    attemptsLeft: KYC_MAX_ATTEMPTS,
    blockedReason: null,
    lastFailureReason: null,
    nameMatchScore: null,
    pennyDropName: null,
    panRegisteredName: null,
    duplicatePanFlagged: false,
    submittedAt: null,
    verifiedAt: null,
    destination: null,
    lifetimeEarningsPaise,
    panRequired: lifetimeEarningsPaise > PAN_REQUIRED_ABOVE_PAISE,
    canSubmit: configured,
    configured,
    panVerificationAvailable: panAvailable,
  };
}

/**
 * Net earnings that have not been taken back — the figure spec §6's ₹5,000 line
 * is drawn against.
 *
 * `pending` counts. The job is delivered and the money is the worker's the
 * moment it is accepted, so a worker who crosses the line during the 48-hour
 * maturity should not be able to finish KYC without a PAN by being quick.
 */
async function lifetimeEarnings(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("worker_earnings")
    .select("net_paise, status")
    .eq("worker_id", workerId);

  if (error) throw new Error(`could not total earnings: ${error.message}`);

  return (data ?? [])
    .filter((row) => row.status !== "reversed" && row.status !== "forfeited")
    .reduce((total, row) => total + row.net_paise, 0);
}

export async function loadWorkerKyc(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<KycOverview> {
  const configured = isKycConfigured();
  const panAvailable = isPanVerificationConfigured();

  const [kyc, methods, lifetimeEarningsPaise] = await Promise.all([
    supabase.from("worker_kyc").select(KYC_COLUMNS).eq("worker_id", workerId).maybeSingle(),
    supabase
      .from("payout_methods")
      .select(METHOD_COLUMNS)
      .eq("worker_id", workerId)
      .order("created_at", { ascending: false }),
    lifetimeEarnings(supabase, workerId),
  ]);

  if (kyc.error) throw new Error(`could not read KYC: ${kyc.error.message}`);
  if (methods.error) {
    throw new Error(`could not read payout methods: ${methods.error.message}`);
  }

  const panRequired = lifetimeEarningsPaise > PAN_REQUIRED_ABOVE_PAISE;

  if (!kyc.data) return emptyOverview(lifetimeEarningsPaise, configured, panAvailable);

  const row = kyc.data;
  const rows = methods.data ?? [];

  // The one this attempt is validating, or failing that the live one. A disabled
  // method is still shown — a worker whose account was rejected should see which
  // account it was.
  const method =
    rows.find((candidate) => candidate.id === row.pending_method_id) ??
    rows.find((candidate) => candidate.disabled_at === null) ??
    rows[0] ??
    null;

  const destination: PayoutDestination | null = method
    ? {
        id: method.id,
        type: method.type,
        status: method.status,
        label: method.label,
        bankName: method.bank_name,
        ifsc: method.ifsc,
        accountLast4: method.account_last4,
        upiMasked: method.upi_handle_masked,
        verifiedAt: method.verified_at,
      }
    : null;

  const attemptsLeft = Math.max(KYC_MAX_ATTEMPTS - row.attempts, 0);

  return {
    status: row.status,
    legalName: row.legal_name,
    dateOfBirth: row.date_of_birth,
    panLast4: row.pan_last4,
    attempts: row.attempts,
    attemptsLeft,
    blockedReason: row.blocked_reason,
    lastFailureReason: row.last_failure_reason,
    nameMatchScore: row.name_match_score,
    pennyDropName: row.penny_drop_name,
    panRegisteredName: row.pan_registered_name,
    duplicatePanFlagged: row.duplicate_pan_flagged,
    submittedAt: row.submitted_at,
    verifiedAt: row.verified_at,
    destination,
    lifetimeEarningsPaise,
    panRequired,
    canSubmit:
      configured &&
      attemptsLeft > 0 &&
      row.status !== "verified" &&
      row.status !== "blocked" &&
      row.status !== "verifying",
    configured,
    panVerificationAvailable: panAvailable,
  };
}
