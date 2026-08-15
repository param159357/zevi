/**
 * Pricing a job for payment.
 *
 * One step above `lib/money/commission.ts`: that module does spec §8's
 * arithmetic and knows nothing about the database; this one loads the rates in
 * effect, applies it, and shapes the result for `open_job_payment` to freeze
 * into `job_financials`.
 *
 * The reason this is its own file rather than four lines inside the action: the
 * quote a client is *shown* and the quote they are *charged* have to be the same
 * calculation, and they are read from different places — the shortlist screen
 * renders one under the client's own key, the payment action recomputes one
 * before creating the order. Two call sites, one function, no chance of them
 * drifting.
 */

import { type CommissionBreakdown, priceJob } from "@/lib/money/commission";
import { loadRates } from "@/lib/money/rates";
import { slabFor } from "@/lib/money/commission";
import type { FrozenPrice, JobQuote } from "@/lib/payments/types";
import type { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** A `CommissionBreakdown` in the shape the database freezes. Field names are
 *  the `job_financials` column names, so the mapping is visible rather than
 *  positional. */
export function toFrozenPrice(breakdown: CommissionBreakdown): FrozenPrice {
  return {
    budget_paise: breakdown.budgetPaise,
    client_commission_bps: breakdown.clientBps,
    worker_commission_bps: breakdown.workerBps,
    client_commission_paise: breakdown.clientCommissionPaise,
    worker_commission_paise: breakdown.workerCommissionPaise,
    tax_rate_bps: breakdown.taxRateBps,
    client_tax_paise: breakdown.clientTaxPaise,
    worker_tax_paise: breakdown.workerTaxPaise,
    client_total_paise: breakdown.clientTotalPaise,
    worker_net_paise: breakdown.workerNetPaise,
    platform_gross_paise: breakdown.commissionPaise,
    floor_applied: breakdown.floorApplied,
    cap_applied: breakdown.capApplied,
  };
}

/**
 * What this job costs at today's rates.
 *
 * Throws rather than returning null on a missing slab: a screen quoting a price
 * can degrade to showing none, but nothing may create a Razorpay order for a
 * job it could not price. The two callers want different failures, so the one
 * that can survive it catches.
 */
export async function quoteJob(
  supabase: ServerSupabaseClient,
  budgetPaise: number,
): Promise<JobQuote> {
  const { slabs, taxRateBps, taxRateId } = await loadRates(supabase);

  const breakdown = priceJob({ budgetPaise, slabs, taxRateBps });
  const slab = slabFor(slabs, budgetPaise);

  // `priceJob` and `slabFor` agree by construction; the second read is only
  // for the slab's id, which the breakdown does not carry.
  if (!breakdown || !slab) {
    throw new Error(
      `No commission slab covers ${budgetPaise} paise. Check commission_slabs.`,
    );
  }

  return {
    breakdown,
    slabId: slab.id,
    taxRateId,
    price: toFrozenPrice(breakdown),
  };
}
