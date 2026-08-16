/**
 * The Razorpay API, as much of it as selection needs.
 *
 * **Server-only.** Every function here reads `RAZORPAY_KEY_SECRET` through
 * `serverEnv`. Importing this from a Client Component puts the secret in the
 * browser bundle — the same rule, and the same reason, as `lib/supabase/server`.
 *
 * Money in: create an order, read a payment back, capture it. Money out: create
 * a refund, read one back, and ask whether one we may already have sent exists.
 * No SDK — the official package is a CommonJS wrapper over the same REST
 * endpoints and brings its own HTTP stack into a runtime that already has
 * `fetch`. A typed wrapper over the endpoints we actually use is smaller, and it
 * is honest about what the responses contain instead of typing them as `any`.
 *
 * Nothing here is a Server Action and nothing here is called from a request a
 * user is waiting on. The refund half is driven by `lib/refunds/drain.ts` from a
 * cron, for the same reason the outbox is: a client whose job was cancelled
 * should wait on our database and not on Razorpay's availability.
 *
 * **Amounts are paise, both ways.** Razorpay's `amount` is the smallest currency
 * unit, which for INR is what this codebase already stores, so nothing is
 * converted at this boundary and nothing here may introduce a float.
 *
 * What this module does *not* do: decide anything. It reports what Razorpay
 * said. Whether a payment is good enough to assign a job on is decided by the
 * caller, against the amount recomputed from the job — never against a number
 * that arrived from a browser, and never against this response alone.
 *
 * ### Route, and what is actually wired
 *
 * Razorpay Route splits a captured payment to *linked accounts* and can hold
 * each split until released — which is the escrow half of spec §4. A linked
 * account is Razorpay's sub-merchant onboarding, and it is a different thing
 * from the contact and fund account that `lib/kyc/` now creates: KYC proves a
 * worker owns a bank account and gives us somewhere to *send* money, which is
 * what a payout takes. It does not make them a sub-merchant.
 *
 * So what runs today is the charge: the client's money is captured into the
 * platform account and held there, with `escrow_holds` and the ledger as the
 * record of whose it is. That is the same position a `{"on_hold": true}` Route
 * transfer leaves the money in, minus the linked account. `transferForJob`
 * below is the seam the split slots into, and it throws rather than pretending.
 */

import { serverEnv } from "@/lib/env";
import { PAYMENT_CURRENCY } from "@/lib/constants/payments";

const API_BASE = "https://api.razorpay.com/v1";

/** Razorpay is in the request path of a client pressing "pay". A hung socket
 *  there is a client staring at a spinner, so the wait is bounded. */
const REQUEST_TIMEOUT_MS = 15_000;

export type RazorpayOrder = {
  id: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
  notes: Record<string, string>;
  created_at: number;
};

export type RazorpayPayment = {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method: string | null;
  captured: boolean;
  /** Razorpay's cut, in paise. Null until the payment is captured. */
  fee: number | null;
  /** GST on that cut, in paise, and included in `fee` — not additional to it. */
  tax: number | null;
  error_code: string | null;
  error_description: string | null;
  notes: Record<string, string>;
  created_at: number;
};

/**
 * A failed Razorpay call, with enough on it to decide what to do next without
 * re-reading the body.
 *
 * `retryable` separates "the network blinked" from "Razorpay says no". Retrying
 * a 4xx just repeats the same refusal; retrying a timeout is the right move,
 * because a timed-out capture may well have succeeded.
 */
export class RazorpayError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code?: string | null }) {
    super(message);
    this.name = "RazorpayError";
    this.status = options.status;
    this.code = options.code ?? null;
    // 0 is a network failure or a timeout: no answer, not a negative one.
    this.retryable = options.status === 0 || options.status === 429 || options.status >= 500;
  }
}

function authorizationHeader(): string {
  const credentials = `${serverEnv.razorpayKeyId}:${serverEnv.razorpayKeySecret}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

/**
 * One request, one place that knows how Razorpay reports a failure.
 *
 * Errors come back as `{"error": {"code": …, "description": …}}`, and the
 * description is written for a developer, not a client — it is logged and
 * carried on the exception, never rendered.
 *
 * Exported for `lib/kyc/razorpay.ts`, which talks to a different set of Razorpay
 * endpoints with the same credentials, the same error envelope and the same
 * reasons to bound the wait. A `path` beginning `http` is used whole — the PAN
 * check lives on a host that arrives with the contract rather than under
 * `api.razorpay.com/v1`.
 */
export async function razorpayRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;

  let response: Response;

  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        Authorization: authorizationHeader(),
        "Content-Type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    throw new RazorpayError(`Could not reach Razorpay (${init.method} ${path}): ${reason}`, {
      status: 0,
    });
  }

  const text = await response.text();

  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error: { code?: string; description?: string } }).error
        : null;

    throw new RazorpayError(
      `Razorpay refused ${init.method} ${path}: ${error?.description ?? response.statusText}`,
      { status: response.status, code: error?.code ?? null },
    );
  }

  if (payload === null) {
    throw new RazorpayError(`Razorpay returned an empty body for ${init.method} ${path}`, {
      status: response.status,
    });
  }

  return payload as T;
}

/**
 * The order a checkout opens against.
 *
 * `receipt` is our payment row's id, so a Razorpay dashboard row can be traced
 * back to a job without a lookup table. The notes carry the job, opt-in and
 * worker for the webhook's benefit — a webhook that arrives after the client
 * closed their tab has the notes and nothing else to go on. They are a hint for
 * finding the payment row, never a claim the payment row has to believe.
 */
export async function createOrder({
  amountPaise,
  receipt,
  notes,
}: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrder> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RazorpayError(`Refusing to create an order for ${amountPaise} paise`, {
      status: 0,
    });
  }

  return razorpayRequest<RazorpayOrder>("/orders", {
    method: "POST",
    body: {
      amount: amountPaise,
      currency: PAYMENT_CURRENCY,
      receipt,
      notes,
      // Capture is ours to do, once the amount has been checked against the job
      // server-side. Auto-capture would take the money before that check.
      payment_capture: 0,
    },
  });
}

export async function fetchPayment(paymentId: string): Promise<RazorpayPayment> {
  return razorpayRequest<RazorpayPayment>(`/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
  });
}

export async function fetchOrder(orderId: string): Promise<RazorpayOrder> {
  return razorpayRequest<RazorpayOrder>(`/orders/${encodeURIComponent(orderId)}`, { method: "GET" });
}

/**
 * Take the authorised money.
 *
 * `amountPaise` must equal what was authorised — Razorpay rejects a mismatch,
 * which is a second check on top of ours and a welcome one.
 *
 * Capturing twice is not an error worth surfacing. Razorpay answers
 * `BAD_REQUEST_ERROR` on an already-captured payment, and a retried settlement
 * reaching that point means the first attempt got further than it managed to
 * record. So this re-reads the payment and returns it if it is genuinely
 * captured, and only then decides the refusal was real.
 */
export async function capturePayment({
  paymentId,
  amountPaise,
}: {
  paymentId: string;
  amountPaise: number;
}): Promise<RazorpayPayment> {
  try {
    return await razorpayRequest<RazorpayPayment>(
      `/payments/${encodeURIComponent(paymentId)}/capture`,
      { method: "POST", body: { amount: amountPaise, currency: PAYMENT_CURRENCY } },
    );
  } catch (error) {
    if (!(error instanceof RazorpayError) || error.retryable) throw error;

    const payment = await fetchPayment(paymentId);
    if (payment.status === "captured" && payment.amount === amountPaise) return payment;

    throw error;
  }
}

/**
 * A refund, as Razorpay reports it.
 *
 * `status` is the whole reason this module has a poll in it. A refund is not
 * synchronous: `processed` means the money has been sent back, `pending` means
 * Razorpay has the instruction and the acquirer has not finished with it, and
 * that second state can last minutes on UPI and rather longer on a card.
 * `failed` is terminal and rare — usually the acquirer refusing an instrument
 * that has since been closed.
 */
export type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
  speed_requested: string | null;
  speed_processed: string | null;
  receipt: string | null;
  notes: Record<string, string>;
  created_at: number;
};

/**
 * The note Razorpay carries back for us, and what makes a retried submission
 * safe. See `findRefundByReference` below.
 */
const REFUND_REFERENCE_NOTE = "zevi_refund_id";

/**
 * Send money back.
 *
 * `speed: "normal"` on purpose. Razorpay's `optimum` uses the instant rails
 * where the instrument supports them and charges for the privilege; spec §14
 * promises 5–7 working days and has Zevi absorbing the gateway's cut, so paying
 * extra to beat a promise nobody made is a cost with no buyer.
 *
 * **The notes are load-bearing, not decoration.** Razorpay's refund endpoint has
 * no idempotency key — unlike capture, a repeated call creates a *second*
 * refund, which is real money gone. So every submission stamps our `refunds`
 * row id into the notes, and `findRefundByReference` is what a retry consults
 * before deciding it has anything to submit.
 */
export async function createRefund({
  paymentId,
  amountPaise,
  refundId,
  notes,
}: {
  paymentId: string;
  amountPaise: number;
  refundId: string;
  notes?: Record<string, string>;
}): Promise<RazorpayRefund> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) {
    throw new RazorpayError(`Refusing to refund ${amountPaise} paise`, { status: 0 });
  }

  return razorpayRequest<RazorpayRefund>(
    `/payments/${encodeURIComponent(paymentId)}/refund`,
    {
      method: "POST",
      body: {
        amount: amountPaise,
        speed: "normal",
        receipt: refundId,
        notes: { ...notes, [REFUND_REFERENCE_NOTE]: refundId },
      },
    },
  );
}

export async function fetchRefund(refundId: string): Promise<RazorpayRefund> {
  return razorpayRequest<RazorpayRefund>(`/refunds/${encodeURIComponent(refundId)}`, {
    method: "GET",
  });
}

/**
 * Has this refund already been submitted?
 *
 * The question a retry has to answer before it does anything, and it cannot be
 * answered from our own rows: the case that matters is precisely the one where
 * Razorpay accepted a refund and we never recorded the id — a timeout, a
 * function killed mid-call, a deploy landing between the POST and the write.
 * Our row says "not submitted" and Razorpay says otherwise, so Razorpay is
 * asked.
 *
 * `notes` survives on the refund entity, so the match is exact rather than
 * heuristic. Matching on amount would be a guess, and on a job that was split
 * and later refunded again it would be the wrong guess.
 *
 * Returns null when there is genuinely nothing there — which is the common
 * answer, and the one that lets a submission go ahead.
 */
export async function findRefundByReference({
  paymentId,
  refundId,
}: {
  paymentId: string;
  refundId: string;
}): Promise<RazorpayRefund | null> {
  const page = await razorpayRequest<{ count: number; items: RazorpayRefund[] }>(
    `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
    { method: "GET" },
  );

  return (
    page.items?.find((refund) => refund.notes?.[REFUND_REFERENCE_NOTE] === refundId) ?? null
  );
}

/**
 * Route's other half — the transfer to a worker's linked account.
 *
 * Not built, and not stubbed to look built. A worker has no *linked* account:
 * KYC (0033) creates a RazorpayX contact and fund account, which is where a
 * payout is sent, not a sub-merchant Route can split a payment to. Escrow is
 * recorded in `escrow_holds` and the ledger meanwhile, which is where the
 * money's ownership actually lives.
 *
 * Kept here so the seam is visible: with linked accounts, this creates the
 * transfer with `on_hold: true` at capture and releases it at acceptance, and
 * the ledger entries it already writes stop being the only record.
 */
export async function transferForJob(): Promise<never> {
  throw new Error(
    "Route transfers need worker linked accounts, which need KYC (spec §6). " +
      "Escrow is held on the platform account and recorded in escrow_holds until then.",
  );
}
