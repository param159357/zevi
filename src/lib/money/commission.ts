/**
 * The commission calculator — spec §8.
 *
 * The one implementation of this arithmetic. The database holds the *numbers*
 * (`commission_slabs`, `tax_rates`, versioned so a job priced in March is still
 * explicable in September) and offers lookup only; the floor, the cap and the
 * split live here. Nothing may inline a slab percentage anywhere else.
 *
 * Rules this encodes, in the order they apply:
 *
 *   1. Gross commission is `total_bps` of the budget.
 *   2. The ₹25 floor lifts it; the ₹1,500 cap on the top slab holds it down.
 *   3. Whatever gross ends up being, it splits in the slab's own
 *      client:worker ratio — 7:6 at the bottom slab. The floor never lands
 *      wholly on one side, and the client always carries the larger share.
 *   4. GST is added *on top of* each side's share as its own line. It is
 *      collected, not earned: it belongs to the government and must never
 *      appear in a revenue figure.
 *
 * The client's share is added to the budget; the worker's is deducted from it.
 * Both sides see every line — spec §5 requires it and so does the law.
 *
 * Not modelled yet, deliberately: loyalty and subscription discounts (V1
 * excludes both, spec §16). When they land they come off one side's share
 * before step 2, because the floor applies after all discounts.
 */

/** The columns of `commission_slabs` this calculation needs. */
export type CommissionSlab = {
  id: string;
  label: string;
  min_paise: number;
  max_paise: number | null;
  total_bps: number;
  client_bps: number;
  worker_bps: number;
  min_commission_paise: number;
  max_commission_paise: number | null;
};

export type CommissionBreakdown = {
  budgetPaise: number;
  slabLabel: string;
  /** Gross commission, both sides together, before GST. Zevi's revenue. */
  commissionPaise: number;
  clientCommissionPaise: number;
  clientTaxPaise: number;
  /** Budget + the client's share + GST on it. What the card is charged. */
  clientTotalPaise: number;
  workerCommissionPaise: number;
  workerTaxPaise: number;
  /** Budget less the worker's share and GST on it. What the worker is paid. */
  workerNetPaise: number;
  /** GST from both sides. A liability, never revenue. */
  taxPaise: number;
  taxRateBps: number;
  clientBps: number;
  workerBps: number;
  /** The ₹25 floor lifted this job's commission (only bites at the bottom). */
  floorApplied: boolean;
  /** The ₹1,500 cap held it down (only reachable on the top slab). */
  capApplied: boolean;
};

/** Amounts are integers. Rates are basis points, so the maths stays exact. */
function applyBps(paise: number, bps: number): number {
  return Math.round((paise * bps) / 10_000);
}

/** One side's slice of a fixed total, in the slab's own ratio. */
function shareOf(totalPaise: number, sideBps: number, slabBps: number): number {
  return Math.round((totalPaise * sideBps) / slabBps);
}

/** The slab covering this budget, or null if the table has a hole in it. */
export function slabFor(
  slabs: readonly CommissionSlab[],
  budgetPaise: number,
): CommissionSlab | null {
  return (
    slabs.find(
      (slab) =>
        budgetPaise >= slab.min_paise &&
        (slab.max_paise === null || budgetPaise <= slab.max_paise),
    ) ?? null
  );
}

export function calculateCommission({
  budgetPaise,
  slab,
  taxRateBps,
}: {
  budgetPaise: number;
  slab: CommissionSlab;
  taxRateBps: number;
}): CommissionBreakdown {
  const raw = applyBps(budgetPaise, slab.total_bps);

  const floorApplied = raw < slab.min_commission_paise;
  const capApplied =
    slab.max_commission_paise !== null && raw > slab.max_commission_paise;

  let commissionPaise = raw;
  if (floorApplied) commissionPaise = slab.min_commission_paise;
  if (capApplied && slab.max_commission_paise !== null) {
    commissionPaise = slab.max_commission_paise;
  }

  // The client's share is computed and the worker's is what remains, so the two
  // always sum to exactly the gross — at ₹149 that is ₹13.46 and ₹11.54, not
  // two independent roundings that miss the floor by a paisa.
  const clientCommissionPaise =
    floorApplied || capApplied
      ? shareOf(commissionPaise, slab.client_bps, slab.total_bps)
      : applyBps(budgetPaise, slab.client_bps);

  const workerCommissionPaise = commissionPaise - clientCommissionPaise;

  const clientTaxPaise = applyBps(clientCommissionPaise, taxRateBps);
  const workerTaxPaise = applyBps(workerCommissionPaise, taxRateBps);

  return {
    budgetPaise,
    slabLabel: slab.label,
    commissionPaise,
    clientCommissionPaise,
    clientTaxPaise,
    clientTotalPaise: budgetPaise + clientCommissionPaise + clientTaxPaise,
    workerCommissionPaise,
    workerTaxPaise,
    workerNetPaise: budgetPaise - workerCommissionPaise - workerTaxPaise,
    taxPaise: clientTaxPaise + workerTaxPaise,
    taxRateBps,
    clientBps: slab.client_bps,
    workerBps: slab.worker_bps,
    floorApplied,
    capApplied,
  };
}

/**
 * What Zevi keeps once the gateway has taken its cut — the "Zevi net" column of
 * spec §8's worked examples, and the line spec §9 builds a month on.
 *
 * An estimate, and only ever that. It applies the *quoted* gateway rate (2% plus
 * GST on the fee) to what the client pays, because the real figure does not
 * exist until Razorpay returns `fee` and `tax` on the captured payment, and
 * differs by instrument. The ledger records the real one; this exists so a
 * projection can be checked against the spec and so a finance screen can quote
 * a number before settlement.
 *
 * GST is not in here on either side. It is collected from both parties and paid
 * onward — a liability, never revenue — so it nets out of this figure entirely,
 * exactly as spec §9's table says it does.
 *
 * The full gross is realised across two moments: the client's share when the
 * card is charged, the worker's when escrow releases. This is the whole-job
 * figure, so it is what a *completed* job earns, not what settlement earns.
 */
export function estimateNetRevenue(
  breakdown: CommissionBreakdown,
  { gatewayFeeBps, gatewayTaxBps }: { gatewayFeeBps: number; gatewayTaxBps: number },
): {
  grossPaise: number;
  gatewayFeePaise: number;
  gatewayTaxPaise: number;
  netPaise: number;
} {
  const gatewayFeePaise = applyBps(breakdown.clientTotalPaise, gatewayFeeBps);
  const gatewayTaxPaise = applyBps(gatewayFeePaise, gatewayTaxBps);

  return {
    grossPaise: breakdown.commissionPaise,
    gatewayFeePaise,
    gatewayTaxPaise,
    netPaise: breakdown.commissionPaise - gatewayFeePaise - gatewayTaxPaise,
  };
}

/** Nothing renders a price without a slab; this says why when one is missing. */
export function priceJob({
  budgetPaise,
  slabs,
  taxRateBps,
}: {
  budgetPaise: number;
  slabs: readonly CommissionSlab[];
  taxRateBps: number;
}): CommissionBreakdown | null {
  const slab = slabFor(slabs, budgetPaise);
  return slab ? calculateCommission({ budgetPaise, slab, taxRateBps }) : null;
}
