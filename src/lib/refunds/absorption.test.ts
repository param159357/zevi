import { describe, expect, it } from "vitest";

import { absorbedGatewayCostPaise } from "@/lib/refunds/absorption";

/**
 * SPEC §14: "Refunds go back to the original payment method in 5–7 working
 * days. Zevi absorbs the payment gateway fee rather than passing it on."
 *
 * That second sentence is a cost, and this is the arithmetic that puts a number
 * on it. Razorpay keeps its cut when a payment is refunded — the fee was charged
 * on the capture and none of it comes back — so a refunded job leaves the
 * platform down by the share of that fee attributable to the money returned.
 *
 * The worked job below is SPEC §8's ₹149 one, priced the way `commission.ts`
 * prices it, so the figures here are the same figures the rest of the money
 * tests are about rather than round numbers chosen to make a division come out
 * even.
 */

/** SPEC §8's ₹149 job: budget ₹149, client commission ₹13.46, GST ₹2.42. */
const CHARGED_PAISE = 14_900 + 1_346 + 242; // 16,488 paise

/** Razorpay's 2% + GST on that charge, as `settleCapturedPayment` splits it. */
const GATEWAY_FEE_PAISE = 330; // 2% of 16,488, floored
const GATEWAY_TAX_PAISE = 59; // 18% of the fee, floored

const COST = {
  gatewayFeePaise: GATEWAY_FEE_PAISE,
  gatewayTaxPaise: GATEWAY_TAX_PAISE,
};

describe("absorbedGatewayCostPaise", () => {
  it("is the whole cut when the whole charge goes back", () => {
    expect(
      absorbedGatewayCostPaise({
        cost: COST,
        chargedPaise: CHARGED_PAISE,
        refundedPaise: CHARGED_PAISE,
      }),
    ).toBe(GATEWAY_FEE_PAISE + GATEWAY_TAX_PAISE);
  });

  it("counts the tax as part of the cut, because Razorpay keeps both", () => {
    const feeOnly = absorbedGatewayCostPaise({
      cost: { gatewayFeePaise: GATEWAY_FEE_PAISE, gatewayTaxPaise: 0 },
      chargedPaise: CHARGED_PAISE,
      refundedPaise: CHARGED_PAISE,
    });

    expect(feeOnly).toBe(GATEWAY_FEE_PAISE);
    expect(
      absorbedGatewayCostPaise({
        cost: COST,
        chargedPaise: CHARGED_PAISE,
        refundedPaise: CHARGED_PAISE,
      }),
    ).toBeGreaterThan(feeOnly);
  });

  /**
   * The ordinary case, and the one worth being careful about. A full-refund
   * cancellation returns the *budget* (₹149) out of a *charge* of ₹164.88,
   * because what sits in escrow is the budget and the client's commission and
   * GST are a question SPEC §8 leaves open. Apportioning the fee against the
   * budget instead of the charge would claim we absorbed 389 paise on every one
   * of these when we absorbed 351.
   */
  it("pro-rates against what was charged, not against the budget", () => {
    const absorbed = absorbedGatewayCostPaise({
      cost: COST,
      chargedPaise: CHARGED_PAISE,
      refundedPaise: 14_900,
    });

    // floor(389 × 14900 / 16488) = floor(351.5…)
    expect(absorbed).toBe(351);
    expect(absorbed).toBeLessThan(GATEWAY_FEE_PAISE + GATEWAY_TAX_PAISE);
  });

  it("floors rather than rounds, so a cost is never overstated", () => {
    // floor(389 × 8244 / 16488) = floor(194.5) — a half that rounding would
    // push up into a paisa nobody paid.
    expect(
      absorbedGatewayCostPaise({
        cost: COST,
        chargedPaise: CHARGED_PAISE,
        refundedPaise: CHARGED_PAISE / 2,
      }),
    ).toBe(194);
  });

  /**
   * A payment captured before the fee landed on the row — the webhook arriving
   * first, an older row, a gateway that answered without one. The honest record
   * of an unknown cost is nothing, not a number derived from a null treated as
   * a zero somewhere further down.
   */
  it("is zero when the gateway's cut is unknown", () => {
    expect(
      absorbedGatewayCostPaise({
        cost: { gatewayFeePaise: null, gatewayTaxPaise: null },
        chargedPaise: CHARGED_PAISE,
        refundedPaise: 14_900,
      }),
    ).toBe(0);
  });

  it("refuses nonsense rather than inventing a share of it", () => {
    const nonsense = [
      { chargedPaise: 0, refundedPaise: 14_900 },
      { chargedPaise: -16_488, refundedPaise: 14_900 },
      { chargedPaise: CHARGED_PAISE, refundedPaise: 0 },
      { chargedPaise: CHARGED_PAISE, refundedPaise: -14_900 },
      // More back than went in. Impossible per `payments_refund_within_amount`,
      // which is the reason to answer 0 rather than to trust it.
      { chargedPaise: CHARGED_PAISE, refundedPaise: CHARGED_PAISE + 1 },
    ];

    for (const amounts of nonsense) {
      expect(absorbedGatewayCostPaise({ cost: COST, ...amounts })).toBe(0);
    }
  });
});
