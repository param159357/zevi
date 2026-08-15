import type { CommissionBreakdown } from "@/lib/money/commission";

/**
 * What the browser is handed to open Razorpay Checkout.
 *
 * Everything here is either public (the key id, the amount the client is about
 * to be shown anyway) or theirs (their own name and contact, prefilled so they
 * are not retyping it into a payment form). No secret, and nothing the
 * settlement path will believe on the way back: the return trip carries three
 * ids and a signature, and every amount is re-read server-side.
 */
export type CheckoutHandoff = {
  /** Our `payments.id`. The thread back to the job, the price and the opt-in. */
  paymentId: string;
  orderId: string;
  keyId: string;
  amountPaise: number;
  currency: string;
  /** Shown in the Razorpay modal so the client knows what they are paying for. */
  jobTitle: string;
  workerName: string;
  prefill: {
    name: string | null;
    email: string | null;
    contact: string | null;
  };
};

export type StartPaymentResult =
  | { ok: true; checkout: CheckoutHandoff }
  | { ok: false; error: string };

/**
 * `retryable` separates "your card was declined, try another" from "we have
 * your money and could not finish" — the second is not something to offer a
 * client a retry button for, because a second payment is the last thing that
 * should happen next.
 */
export type ConfirmPaymentResult =
  | { ok: true; workerId: string }
  | { ok: false; error: string; retryable: boolean };

/** What `open_job_payment` freezes into `job_financials`. Assembled in one
 *  place from a `CommissionBreakdown` so no caller builds it field by field. */
export type FrozenPrice = {
  budget_paise: number;
  client_commission_bps: number;
  worker_commission_bps: number;
  client_commission_paise: number;
  worker_commission_paise: number;
  tax_rate_bps: number;
  client_tax_paise: number;
  worker_tax_paise: number;
  client_total_paise: number;
  worker_net_paise: number;
  platform_gross_paise: number;
  floor_applied: boolean;
  cap_applied: boolean;
};

export type JobQuote = {
  breakdown: CommissionBreakdown;
  slabId: string;
  taxRateId: string;
  price: FrozenPrice;
};
