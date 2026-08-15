/**
 * The two verification calls spec §6 names.
 *
 * **Server-only.** Both authenticate with `RAZORPAY_KEY_SECRET` through
 * `serverEnv`, and both are reached through `razorpayRequest` from
 * `lib/payments/razorpay.ts` — one place that knows how Razorpay reports a
 * failure, and one timeout, rather than a second copy of both here.
 *
 * ---------------------------------------------------------------------------
 * The penny drop
 *
 * `POST /v1/fund_accounts/validations` in its composite form: it creates the
 * contact, creates the fund account and starts the validation in one call, and
 * returns all three ids. The contact and fund account ids are kept on
 * `payout_methods` because that is what Razorpay's payout and Route APIs take —
 * the destination this builds is the one a transfer will later go to, not a
 * throwaway.
 *
 * **It is asynchronous, and the code is shaped around that being normal.** The
 * call returns `created`; the beneficiary bank answers seconds to minutes later
 * with the name on the account. So `createFundAccountValidation` starts it and
 * `fetchFundAccountValidation` reads it back, and the caller settles whenever
 * the answer arrives. A synchronous `completed` does happen — some VPA
 * validations return one — and is handled by the same path rather than a
 * special case.
 *
 * Razorpay has published this response in two shapes over time: `results` on the
 * older bank-account endpoint and `validation_results` on the composite one.
 * `readValidation` below flattens both, because which one arrives is not
 * something the rest of the codebase should have to know.
 *
 * ---------------------------------------------------------------------------
 * The PAN check, and why its URL is configuration
 *
 * Razorpay's PAN verification is enabled per merchant under contract rather than
 * published alongside the payment APIs, so there is no public path to hardcode.
 * Inventing one would produce code that looks wired and 404s the first time a
 * worker crosses ₹5,000 — the failure would land on the exact person the check
 * exists for. So the endpoint is `RAZORPAY_PAN_VERIFY_URL`, the response is
 * parsed for the fields every provider of this shape returns, and with nothing
 * configured `verifyPan` throws rather than returning a pass.
 *
 * Failing closed is the whole design. A PAN check that quietly succeeds when it
 * cannot run is worse than no PAN check, because the platform would then have a
 * `pan_registered_name` on file that nobody ever read.
 */

import { PENNY_DROP_AMOUNT_PAISE } from "@/lib/constants/kyc";
import { serverEnv, isPanVerificationConfigured } from "@/lib/env";
import { PAYMENT_CURRENCY } from "@/lib/constants/payments";
import { RazorpayError, razorpayRequest } from "@/lib/payments/razorpay";

/** What a bank says about an account it was asked to look at. `active` is the
 *  only one that means the money would arrive. */
export type AccountStatus = "active" | "invalid" | string;

export type ValidationStatus = "created" | "completed" | "failed";

/** The raw envelope, both shapes Razorpay has published. */
type RawValidation = {
  id?: string;
  status?: ValidationStatus;
  utr?: string | null;
  results?: {
    account_status?: string | null;
    registered_name?: string | null;
  } | null;
  validation_results?: {
    account_status?: string | null;
    registered_name?: string | null;
    name_match_score?: number | null;
    details?: string | null;
    bank_account?: { bank_name?: string | null } | null;
  } | null;
  status_details?: {
    description?: string | null;
    reason?: string | null;
    source?: string | null;
  } | null;
  fund_account?: {
    id?: string | null;
    bank_account?: { bank_name?: string | null } | null;
    contact?: { id?: string | null } | null;
  } | null;
};

/** The same answer, one shape, with only what any caller here needs. */
export type FundAccountValidation = {
  id: string;
  status: ValidationStatus;
  /** `active` once the bank has confirmed the account exists and takes credits. */
  accountStatus: AccountStatus | null;
  /** The name the bank holds against the account. The whole point of the call. */
  registeredName: string | null;
  /** Razorpay's own 0–100 opinion of the name, when it offers one. Recorded
   *  beside ours; it does not decide anything — see `lib/kyc/names.ts`. */
  providerNameMatch: number | null;
  bankName: string | null;
  fundAccountId: string | null;
  contactId: string | null;
  /** Why it failed, in Razorpay's words. Logged and shown to an admin, never
   *  rendered to the worker unedited. */
  failureReason: string | null;
};

function readValidation(raw: RawValidation): FundAccountValidation {
  const results = raw.validation_results ?? raw.results ?? null;

  return {
    id: raw.id ?? "",
    status: raw.status ?? "created",
    accountStatus: results?.account_status ?? null,
    registeredName: results?.registered_name?.trim() || null,
    providerNameMatch:
      typeof raw.validation_results?.name_match_score === "number"
        ? raw.validation_results.name_match_score
        : null,
    bankName:
      raw.validation_results?.bank_account?.bank_name ??
      raw.fund_account?.bank_account?.bank_name ??
      null,
    fundAccountId: raw.fund_account?.id ?? null,
    contactId: raw.fund_account?.contact?.id ?? null,
    failureReason:
      raw.status_details?.description ??
      raw.status_details?.reason ??
      raw.validation_results?.details ??
      null,
  };
}

export type BankDestination = {
  kind: "bank_account";
  /** Full, and never stored — see `lib/kyc/hash.ts`. */
  accountNumber: string;
  ifsc: string;
};

export type UpiDestination = {
  kind: "upi";
  vpa: string;
};

export type Destination = BankDestination | UpiDestination;

/**
 * Start the penny drop.
 *
 * The name submitted is the worker's declared legal name, which is what makes
 * Razorpay's own `name_match_score` meaningful when it comes back. It is not
 * what the decision rests on — the bank's `registered_name` is, compared here
 * rather than there.
 */
export async function createFundAccountValidation({
  referenceId,
  declaredName,
  destination,
  contact,
  amountPaise = PENNY_DROP_AMOUNT_PAISE,
}: {
  referenceId: string;
  declaredName: string;
  destination: Destination;
  contact: { email?: string | null; mobile?: string | null };
  amountPaise?: number;
}): Promise<FundAccountValidation> {
  const fundAccount =
    destination.kind === "bank_account"
      ? {
          account_type: "bank_account",
          bank_account: {
            name: declaredName,
            ifsc: destination.ifsc,
            account_number: destination.accountNumber,
          },
        }
      : {
          account_type: "vpa",
          vpa: { address: destination.vpa },
        };

  const raw = await razorpayRequest<RawValidation>("/fund_accounts/validations", {
    method: "POST",
    body: {
      source_account_number: serverEnv.razorpayXAccountNumber,
      amount: amountPaise,
      currency: PAYMENT_CURRENCY,
      // Our KYC row's worker id. A Razorpay dashboard row traces back to a
      // worker without a lookup table, the same way a payment's receipt does.
      reference_id: referenceId,
      notes: { purpose: "worker_kyc", worker_id: referenceId },
      fund_account: {
        ...fundAccount,
        contact: {
          name: declaredName,
          type: "vendor",
          reference_id: referenceId,
          ...(contact.email ? { email: contact.email } : {}),
          ...(contact.mobile ? { contact: contact.mobile } : {}),
        },
      },
    },
  });

  return readValidation(raw);
}

export async function fetchFundAccountValidation(
  validationId: string,
): Promise<FundAccountValidation> {
  const raw = await razorpayRequest<RawValidation>(
    `/fund_accounts/validations/${encodeURIComponent(validationId)}`,
    { method: "GET" },
  );

  return readValidation(raw);
}

export type PanVerification = {
  /** Whether the registry recognised the PAN at all. A false here is a failed
   *  attempt, not a name mismatch — the two have different consequences. */
  found: boolean;
  /** The name the PAN is registered to. Compared against the declared name and
   *  against the bank's, in `lib/kyc/names.ts`. */
  registeredName: string | null;
  detail: string | null;
};

type RawPan = {
  status?: string | null;
  valid?: boolean | null;
  registered_name?: string | null;
  name?: string | null;
  full_name?: string | null;
  pan_status?: string | null;
  description?: string | null;
  message?: string | null;
};

/**
 * The PAN registry's name for a PAN.
 *
 * Read defensively on purpose: the field carrying the name has been
 * `registered_name`, `name` and `full_name` across the versions of this API, and
 * the pass/fail flag has been both a boolean `valid` and a string `status`. This
 * accepts each of them and treats anything it cannot read as *not found*, which
 * makes an unexpected response a failed attempt rather than a silent pass.
 */
export async function verifyPan({
  pan,
  declaredName,
}: {
  pan: string;
  declaredName: string;
}): Promise<PanVerification> {
  if (!isPanVerificationConfigured()) {
    throw new RazorpayError(
      "PAN verification is not configured (RAZORPAY_PAN_VERIFY_URL). Spec §6 makes " +
        "PAN mandatory above ₹5,000 lifetime, so KYC cannot complete past that line " +
        "until it is.",
      { status: 0, code: "PAN_VERIFICATION_UNAVAILABLE" },
    );
  }

  const raw = await razorpayRequest<RawPan>(serverEnv.razorpayPanVerifyUrl, {
    method: "POST",
    body: { pan, name: declaredName },
  });

  const registeredName =
    (raw.registered_name ?? raw.name ?? raw.full_name ?? "").trim() || null;

  const flagged =
    raw.valid === true ||
    raw.status === "valid" ||
    raw.status === "VALID" ||
    raw.status === "success" ||
    raw.pan_status === "VALID" ||
    raw.pan_status === "E"; // NSDL's code for an existing individual PAN.

  return {
    // A name came back and nothing said the PAN was invalid, or a flag said so
    // outright. Either is enough to have something to compare; neither decides
    // whether it matches.
    found: flagged || registeredName !== null,
    registeredName,
    detail: raw.description ?? raw.message ?? null,
  };
}
