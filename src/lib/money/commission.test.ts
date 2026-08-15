import { describe, expect, it } from "vitest";

import { GATEWAY_FEE_BPS, GATEWAY_FEE_TAX_BPS } from "@/lib/constants/payments";
import {
  type CommissionSlab,
  calculateCommission,
  estimateNetRevenue,
  priceJob,
  slabFor,
} from "@/lib/money/commission";

/**
 * SPEC §8, checked line by line.
 *
 * The worked examples table is the specification of this module. It is not five
 * illustrations of a rule stated elsewhere — the rule *is* those five rows, and
 * the ₹149 one exists precisely because the prose ("the floor splits in the
 * slab's own ratio") is ambiguous until you see ₹13.46 and ₹11.54 written down.
 * So every row is a test, and every column of every row is an assertion.
 *
 * The slabs and the GST rate below mirror the seed in migration 0018. They are
 * duplicated rather than read from the database because that is the point: if
 * someone edits a seeded rate, these tests should fail and say which spec row
 * they broke. Versioned rates mean production can legitimately hold different
 * numbers one day; the spec's worked examples cannot change without the spec.
 */

const SLABS: CommissionSlab[] = [
  {
    id: "slab-149",
    label: "₹149–499",
    min_paise: 14_900,
    max_paise: 49_999,
    total_bps: 1_300,
    client_bps: 700,
    worker_bps: 600,
    min_commission_paise: 2_500,
    max_commission_paise: null,
  },
  {
    id: "slab-500",
    label: "₹500–1,999",
    min_paise: 50_000,
    max_paise: 199_999,
    total_bps: 1_100,
    client_bps: 600,
    worker_bps: 500,
    min_commission_paise: 2_500,
    max_commission_paise: null,
  },
  {
    id: "slab-2000",
    label: "₹2,000–4,999",
    min_paise: 200_000,
    max_paise: 499_999,
    total_bps: 900,
    client_bps: 500,
    worker_bps: 400,
    min_commission_paise: 2_500,
    max_commission_paise: null,
  },
  {
    id: "slab-5000",
    label: "₹5,000+",
    min_paise: 500_000,
    max_paise: null,
    total_bps: 800,
    client_bps: 450,
    worker_bps: 350,
    min_commission_paise: 2_500,
    max_commission_paise: 150_000,
  },
];

/** `tax_rates.gst_commission`. 18%, and configurable — never inlined. */
const GST_BPS = 1_800;

const GATEWAY = {
  gatewayFeeBps: GATEWAY_FEE_BPS,
  gatewayTaxBps: GATEWAY_FEE_TAX_BPS,
};

function price(budgetPaise: number) {
  const breakdown = priceJob({ budgetPaise, slabs: SLABS, taxRateBps: GST_BPS });
  if (!breakdown) throw new Error(`No slab covers ${budgetPaise} paise`);
  return breakdown;
}

// ---------------------------------------------------------------------------
// The worked examples — SPEC §8
// ---------------------------------------------------------------------------

/**
 * One case per row, all six columns.
 *
 * `netRupeesApprox` is the spec's tilde column. Zevi net is never a round number
 * — the ₹400 job nets ₹41.78 — so the spec quotes the whole rupees actually
 * banked and this compares against exactly that. The paise figure is asserted
 * separately and exactly, so the approximation is documented, not relied on.
 */
const WORKED_EXAMPLES = [
  {
    job: "₹149",
    budgetPaise: 14_900,
    slabLabel: "₹149–499",
    clientPaysPaise: 16_488,
    workerGetsPaise: 13_538,
    grossPaise: 2_500,
    gstPaise: 450,
    netPaise: 2_111,
    netRupeesApprox: 21,
    floorApplied: true,
  },
  {
    job: "₹400",
    budgetPaise: 40_000,
    slabLabel: "₹149–499",
    clientPaysPaise: 43_304,
    workerGetsPaise: 37_168,
    grossPaise: 5_200,
    gstPaise: 936,
    netPaise: 4_178,
    netRupeesApprox: 41,
    floorApplied: false,
  },
  {
    job: "₹500",
    budgetPaise: 50_000,
    slabLabel: "₹500–1,999",
    clientPaysPaise: 53_540,
    workerGetsPaise: 47_050,
    grossPaise: 5_500,
    gstPaise: 990,
    netPaise: 4_236,
    netRupeesApprox: 42,
    floorApplied: false,
  },
  {
    job: "₹2,000",
    budgetPaise: 200_000,
    slabLabel: "₹2,000–4,999",
    clientPaysPaise: 211_800,
    workerGetsPaise: 190_560,
    grossPaise: 18_000,
    gstPaise: 3_240,
    netPaise: 13_002,
    netRupeesApprox: 130,
    floorApplied: false,
  },
  {
    job: "₹10,000",
    budgetPaise: 1_000_000,
    slabLabel: "₹5,000+",
    clientPaysPaise: 1_053_100,
    workerGetsPaise: 958_700,
    grossPaise: 80_000,
    gstPaise: 14_400,
    netPaise: 55_147,
    netRupeesApprox: 551,
    floorApplied: false,
  },
] as const;

describe("SPEC §8 worked examples", () => {
  for (const example of WORKED_EXAMPLES) {
    describe(`a ${example.job} job`, () => {
      const breakdown = price(example.budgetPaise);
      const net = estimateNetRevenue(breakdown, GATEWAY);

      it(`lands in the ${example.slabLabel} slab`, () => {
        expect(breakdown.slabLabel).toBe(example.slabLabel);
      });

      it(`charges the client ${example.clientPaysPaise} paise`, () => {
        expect(breakdown.clientTotalPaise).toBe(example.clientPaysPaise);
      });

      it(`pays the worker ${example.workerGetsPaise} paise`, () => {
        expect(breakdown.workerNetPaise).toBe(example.workerGetsPaise);
      });

      it(`earns ${example.grossPaise} paise gross`, () => {
        expect(breakdown.commissionPaise).toBe(example.grossPaise);
      });

      it(`collects ${example.gstPaise} paise of GST`, () => {
        expect(breakdown.taxPaise).toBe(example.gstPaise);
      });

      it(`nets ${example.netPaise} paise after the gateway`, () => {
        expect(net.netPaise).toBe(example.netPaise);
        // The spec's "~₹21" column: whole rupees actually kept.
        expect(Math.floor(net.netPaise / 100)).toBe(example.netRupeesApprox);
      });

      it(example.floorApplied ? "is lifted by the ₹25 floor" : "is above the ₹25 floor", () => {
        expect(breakdown.floorApplied).toBe(example.floorApplied);
        expect(breakdown.capApplied).toBe(false);
      });

      it("keeps GST out of the net revenue figure", () => {
        // Spec §8: GST is collected, not earned. §9's table nets it to zero.
        // Net is gross less the gateway only — no GST term on either side.
        expect(net.netPaise).toBe(
          net.grossPaise - net.gatewayFeePaise - net.gatewayTaxPaise,
        );
        expect(net.netPaise).toBeLessThan(breakdown.commissionPaise);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The ₹149 job, line by line — SPEC §8's second table
// ---------------------------------------------------------------------------

describe("the ₹149 job, line by line", () => {
  const breakdown = price(14_900);

  it("starts from a ₹149.00 budget", () => {
    expect(breakdown.budgetPaise).toBe(14_900);
  });

  it("charges the client ₹13.46 — 7/13 of the ₹25 floor", () => {
    expect(breakdown.clientCommissionPaise).toBe(1_346);
  });

  it("adds ₹2.42 of GST on the client's commission", () => {
    expect(breakdown.clientTaxPaise).toBe(242);
  });

  it("totals ₹164.88 for the client", () => {
    expect(breakdown.clientTotalPaise).toBe(16_488);
    expect(breakdown.clientTotalPaise).toBe(
      breakdown.budgetPaise + breakdown.clientCommissionPaise + breakdown.clientTaxPaise,
    );
  });

  it("charges the worker ₹11.54 — 6/13 of the ₹25 floor", () => {
    expect(breakdown.workerCommissionPaise).toBe(1_154);
  });

  it("adds ₹2.08 of GST on the worker's commission", () => {
    expect(breakdown.workerTaxPaise).toBe(208);
  });

  it("leaves the worker ₹135.38", () => {
    expect(breakdown.workerNetPaise).toBe(13_538);
    expect(breakdown.workerNetPaise).toBe(
      breakdown.budgetPaise - breakdown.workerCommissionPaise - breakdown.workerTaxPaise,
    );
  });

  it("earns ₹25.00 gross", () => {
    expect(breakdown.commissionPaise).toBe(2_500);
  });

  it("lifts ₹19.37 of raw commission to the ₹25 floor", () => {
    // 13% of ₹149 is ₹19.37. The floor is what the client and worker are
    // actually charged, and the gap is the whole reason this row is in the spec.
    const raw = Math.round((14_900 * 1_300) / 10_000);
    expect(raw).toBe(1_937);
    expect(breakdown.commissionPaise).toBeGreaterThan(raw);
    expect(breakdown.floorApplied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The ₹25 floor
// ---------------------------------------------------------------------------

describe("the ₹25 floor", () => {
  it("splits 7:6, never wholly onto one side", () => {
    const breakdown = price(14_900);

    expect(breakdown.clientCommissionPaise).toBe(1_346);
    expect(breakdown.workerCommissionPaise).toBe(1_154);
    // Spec §8: "The floor never lands wholly on one side."
    expect(breakdown.workerCommissionPaise).toBeGreaterThan(0);
    // Spec §8: "the client still pays the larger share of it."
    expect(breakdown.clientCommissionPaise).toBeGreaterThan(breakdown.workerCommissionPaise);
  });

  it("splits to exactly ₹25 — the remainder goes to the worker, not to rounding", () => {
    const breakdown = price(14_900);

    expect(breakdown.clientCommissionPaise + breakdown.workerCommissionPaise).toBe(2_500);
  });

  it("stops being the binding rule at ₹192.27", () => {
    // 13% of the budget rounds up to ₹25 at ₹192.27 — a paisa below that the
    // floor is what sets the fee, at it the slab already does. Both sides of the
    // boundary, so a change to the rounding in `applyBps` cannot quietly move it.
    expect(price(19_226).floorApplied).toBe(true);
    expect(price(19_227).floorApplied).toBe(false);

    // The client and worker cannot tell the difference, which is the point: the
    // fee is ₹25 either way, and it splits 7:6 either way.
    for (const budgetPaise of [19_226, 19_227]) {
      expect(price(budgetPaise).commissionPaise).toBe(2_500);
      expect(price(budgetPaise).clientCommissionPaise).toBe(1_346);
      expect(price(budgetPaise).workerCommissionPaise).toBe(1_154);
    }
  });

  it("holds the fee at exactly ₹25 until the slab overtakes it at ₹192.35", () => {
    expect(price(19_234).commissionPaise).toBe(2_500);
    expect(price(19_235).commissionPaise).toBe(2_501);
  });

  it("is charged on the smallest job the platform allows", () => {
    // `job.min_budget_paise` is ₹149, so this is the floor's real lower bound.
    const breakdown = price(14_900);

    expect(breakdown.commissionPaise).toBe(2_500);
    expect(breakdown.workerNetPaise).toBeLessThan(breakdown.budgetPaise);
  });

  it("never applies above the bottom slab", () => {
    // Every slab carries the same ₹25 minimum, but ₹500 at 11% is already ₹55 —
    // so the floor is a bottom-slab rule in practice, and the test says so.
    for (const budget of [50_000, 200_000, 500_000, 1_000_000]) {
      expect(price(budget).floorApplied).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The ₹1,500 cap
// ---------------------------------------------------------------------------

describe("the ₹1,500 cap on the top slab", () => {
  // 8% reaches ₹1,500 at ₹18,750. `job.max_budget_paise` is ₹5,000 today
  // (spec §10 caps job value for the first three months), so nothing can reach
  // this yet — the slab row carries the cap, and the calculator must honour it
  // the day that setting is raised.
  const CAP_BUDGET_PAISE = 1_875_000;

  it("does not bite just below ₹18,750", () => {
    const breakdown = price(CAP_BUDGET_PAISE - 100);

    expect(breakdown.capApplied).toBe(false);
    expect(breakdown.commissionPaise).toBe(149_992);
  });

  it("holds commission at ₹1,500 above it", () => {
    const breakdown = price(5_000_000);

    expect(breakdown.capApplied).toBe(true);
    expect(breakdown.commissionPaise).toBe(150_000);
  });

  it("splits the capped fee 4.5:3.5, summing to exactly ₹1,500", () => {
    const breakdown = price(5_000_000);

    expect(breakdown.clientCommissionPaise).toBe(84_375);
    expect(breakdown.workerCommissionPaise).toBe(65_625);
    expect(breakdown.clientCommissionPaise + breakdown.workerCommissionPaise).toBe(150_000);
    expect(breakdown.clientCommissionPaise).toBeGreaterThan(breakdown.workerCommissionPaise);
  });
});

// ---------------------------------------------------------------------------
// Slab selection
// ---------------------------------------------------------------------------

describe("slab boundaries", () => {
  const CASES: [number, string][] = [
    [14_900, "₹149–499"],
    [49_999, "₹149–499"],
    [50_000, "₹500–1,999"],
    [199_999, "₹500–1,999"],
    [200_000, "₹2,000–4,999"],
    [499_999, "₹2,000–4,999"],
    [500_000, "₹5,000+"],
    [100_000_000, "₹5,000+"],
  ];

  for (const [budgetPaise, label] of CASES) {
    it(`${budgetPaise} paise falls in ${label}`, () => {
      expect(slabFor(SLABS, budgetPaise)?.label).toBe(label);
    });
  }

  it("finds no slab below the ₹149 minimum", () => {
    expect(slabFor(SLABS, 14_899)).toBeNull();
    expect(priceJob({ budgetPaise: 14_899, slabs: SLABS, taxRateBps: GST_BPS })).toBeNull();
  });

  it("charges the client more than the worker at every slab", () => {
    // Spec §8: "Client always pays the higher share — workers are the scarce side."
    for (const slab of SLABS) {
      expect(slab.client_bps).toBeGreaterThan(slab.worker_bps);
      expect(slab.client_bps + slab.worker_bps).toBe(slab.total_bps);
    }
  });

  it("charges a descending rate as jobs get bigger", () => {
    // Spec §8: "Descending by design" — leakage hurts most on the big jobs.
    const rates = SLABS.map((slab) => slab.total_bps);
    expect(rates).toEqual([...rates].sort((a, b) => b - a));
    expect(new Set(rates).size).toBe(rates.length);
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold at every budget
// ---------------------------------------------------------------------------

describe("invariants across the whole budget range", () => {
  const BUDGETS = [
    14_900, 14_901, 19_230, 19_231, 25_000, 40_000, 49_999, 50_000, 99_999,
    123_457, 199_999, 200_000, 333_333, 499_999, 500_000, 777_777, 1_000_000,
    1_874_999, 1_875_000, 5_000_000,
  ];

  it("splits gross commission with nothing lost to rounding", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.clientCommissionPaise + b.workerCommissionPaise).toBe(b.commissionPaise);
    }
  });

  it("adds the client's share and deducts the worker's", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.clientTotalPaise).toBe(
        b.budgetPaise + b.clientCommissionPaise + b.clientTaxPaise,
      );
      expect(b.workerNetPaise).toBe(
        b.budgetPaise - b.workerCommissionPaise - b.workerTaxPaise,
      );
      expect(b.clientTotalPaise).toBeGreaterThan(b.budgetPaise);
      expect(b.workerNetPaise).toBeLessThan(b.budgetPaise);
    }
  });

  it("keeps GST as its own line on each share, never folded in", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.clientTaxPaise).toBe(Math.round((b.clientCommissionPaise * GST_BPS) / 10_000));
      expect(b.workerTaxPaise).toBe(Math.round((b.workerCommissionPaise * GST_BPS) / 10_000));
      expect(b.taxPaise).toBe(b.clientTaxPaise + b.workerTaxPaise);
    }
  });

  it("reconciles: what the client pays, less what the worker gets, is fee plus GST", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.clientTotalPaise - b.workerNetPaise).toBe(b.commissionPaise + b.taxPaise);
    }
  });

  it("produces whole paise everywhere — no floats near money", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      for (const amount of [
        b.commissionPaise,
        b.clientCommissionPaise,
        b.clientTaxPaise,
        b.clientTotalPaise,
        b.workerCommissionPaise,
        b.workerTaxPaise,
        b.workerNetPaise,
        b.taxPaise,
      ]) {
        expect(Number.isInteger(amount)).toBe(true);
      }
    }
  });

  it("leaves the client always paying the larger share", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.clientCommissionPaise).toBeGreaterThan(b.workerCommissionPaise);
    }
  });

  it("never charges more than the job is worth", () => {
    for (const budgetPaise of BUDGETS) {
      const b = price(budgetPaise);
      expect(b.commissionPaise).toBeLessThan(b.budgetPaise);
      expect(b.workerNetPaise).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// GST is configurable, not 18%
// ---------------------------------------------------------------------------

describe("GST as a configurable line item", () => {
  it("follows the rate it is given", () => {
    const at18 = calculateCommission({ budgetPaise: 40_000, slab: SLABS[0], taxRateBps: 1_800 });
    const at12 = calculateCommission({ budgetPaise: 40_000, slab: SLABS[0], taxRateBps: 1_200 });

    expect(at18.taxPaise).toBe(936);
    expect(at12.taxPaise).toBe(624);
    // The commission itself does not move. GST sits on top of it.
    expect(at12.commissionPaise).toBe(at18.commissionPaise);
    expect(at12.clientCommissionPaise).toBe(at18.clientCommissionPaise);
  });

  it("disappears entirely at zero without disturbing the fee", () => {
    const b = calculateCommission({ budgetPaise: 40_000, slab: SLABS[0], taxRateBps: 0 });

    expect(b.taxPaise).toBe(0);
    expect(b.commissionPaise).toBe(5_200);
    expect(b.clientTotalPaise).toBe(42_800);
    expect(b.workerNetPaise).toBe(37_600);
  });
});
