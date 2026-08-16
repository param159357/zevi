/**
 * What giving the money back cost us — spec §14.
 *
 * "Zevi absorbs the payment gateway fee on refunds rather than passing it on"
 * is a sentence about a real number, and this is the number. Razorpay keeps its
 * cut when a payment is refunded: the fee was charged on the capture and no part
 * of it comes back, so a refunded job leaves the platform out of pocket by the
 * share of that fee attributable to the money returned.
 *
 * **Nothing here moves.** The cost was recognised at capture — 0029 debits
 * `gateway_fees` and credits `platform_revenue` for the whole fee — so no ledger
 * entry follows from this figure and 0038 writes none. What it does is make
 * `refunds.gateway_fee_absorbed_paise` answerable, which is the difference
 * between knowing what refunds cost and having to work it out from two other
 * tables at the end of a quarter.
 *
 * Pure, and separate from the drain, so it is testable without a Supabase
 * client and without a gateway — the same reason `lib/payouts/cycle.ts` and
 * `lib/cancellations/tiers.ts` sit apart from the functions that use them.
 */

/**
 * The gateway's cut on a capture, in paise.
 *
 * Two columns because the ledger needs a cost and a tax kept apart (see
 * `settleCapturedPayment`), one number because Razorpay charges them together
 * and neither half is refunded. Anything missing counts as zero: a payment
 * captured before the fee landed on the row is a payment whose absorbed cost is
 * genuinely unknown, and guessing at it would be worse than recording nothing.
 */
export type GatewayCost = {
  gatewayFeePaise: number | null;
  gatewayTaxPaise: number | null;
};

/**
 * The share of the gateway's cut attributable to a partial refund.
 *
 * Pro-rated against what was *charged*, not against the budget. The fee was
 * levied on the whole charge — budget plus the client's commission plus GST —
 * so apportioning it against the budget alone would overstate the cost of
 * every refund this platform issues, given that a refund is the budget and the
 * charge is more than the budget.
 *
 * **Floored**, like every other division in this codebase: paise are the
 * resolution of the answer, and a cost is never rounded up into a figure nobody
 * paid. On a full refund the floor is exact, because the ratio is one.
 *
 * Zero on anything nonsensical — a charge of zero, a negative amount, a refund
 * larger than the charge. Those are all "we do not know", and the honest record
 * of an unknown cost is 0 with the fee still readable on `payments`, not a
 * number invented to fill a column.
 */
export function absorbedGatewayCostPaise({
  cost,
  chargedPaise,
  refundedPaise,
}: {
  cost: GatewayCost;
  chargedPaise: number;
  refundedPaise: number;
}): number {
  const total = Math.max(cost.gatewayFeePaise ?? 0, 0) + Math.max(cost.gatewayTaxPaise ?? 0, 0);

  if (total <= 0) return 0;
  if (!Number.isFinite(chargedPaise) || chargedPaise <= 0) return 0;
  if (!Number.isFinite(refundedPaise) || refundedPaise <= 0) return 0;
  if (refundedPaise > chargedPaise) return 0;

  return Math.floor((total * refundedPaise) / chargedPaise);
}
