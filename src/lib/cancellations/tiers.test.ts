import { describe, expect, it } from "vitest";

import {
  CANCELLATION_FEE_PAISE,
  LATE_CLIENT_CAP_BPS,
} from "@/lib/constants/cancellations";
import {
  type JobTiming,
  cancellationTier,
  elapsedBps,
  quoteCancellation,
} from "@/lib/cancellations/tiers";

/**
 * SPEC §5, "Cancellation", checked line by line against a job with a window you
 * can do in your head.
 *
 * | When                      | Refund                                          |
 * |---------------------------|-------------------------------------------------|
 * | No worker assigned yet    | Full, instant, no fee                           |
 * | ≤30% of deadline elapsed  | Full, minus ₹15                                 |
 * | 31–50% elapsed            | 80% client / 20% worker, minus ₹15              |
 * | >50% elapsed              | Admin assesses; client refund capped at 70%     |
 * | After delivery            | No percentage refund — accept, revise, dispute   |
 *
 * The window below is **ten days**, assigned at midnight on the 1st and due at
 * midnight on the 11th, so "day 3" is exactly 30% and "day 5" is exactly 50% and
 * every boundary in the table is a date rather than a computed fraction. That is
 * the same choice `eligibility.test.ts` makes about the payout fortnight: a test
 * that derives its expectation the way the code does proves only that the code
 * agrees with itself.
 *
 * The budget is ₹1,000 (100000 paise) because 20% of it is a round ₹200 and the
 * ₹15 fee is visible next to it. One block at the ₹149 minimum checks the case
 * the rounding rules exist for.
 */

const DAY_MS = 86_400_000;

const ASSIGNED = new Date("2026-08-01T00:00:00.000Z");
const DEADLINE = new Date("2026-08-11T00:00:00.000Z"); // ten days later

/** `n` days into the ten-day window. */
function day(n: number): Date {
  return new Date(ASSIGNED.getTime() + n * DAY_MS);
}

/**
 * One basis point of the ten-day window — 86.4 seconds.
 *
 * The smallest step that can move a tier, because basis points are the unit the
 * decision is made in. "One millisecond past 30%" is not a thing that exists
 * here, and a test asserting it would be testing the clock rather than the rule.
 */
const ONE_BPS_MS = (10 * DAY_MS) / 10_000;

const ASSIGNED_JOB: JobTiming = {
  assignedAt: ASSIGNED,
  deadlineAt: DEADLINE,
  hasDelivery: false,
};

const BUDGET = 100_000; // ₹1,000

describe("elapsed is measured from assignment, not from posting", () => {
  it("is null before anyone is picked", () => {
    expect(
      elapsedBps({ assignedAt: null, deadlineAt: DEADLINE, hasDelivery: false }, day(3)),
    ).toBeNull();
  });

  it("reads the fraction of the worker's own window", () => {
    expect(elapsedBps(ASSIGNED_JOB, day(0))).toBe(0);
    expect(elapsedBps(ASSIGNED_JOB, day(3))).toBe(3_000);
    expect(elapsedBps(ASSIGNED_JOB, day(5))).toBe(5_000);
    expect(elapsedBps(ASSIGNED_JOB, day(10))).toBe(10_000);
  });

  it("clamps at both ends rather than going negative or past the deadline", () => {
    expect(elapsedBps(ASSIGNED_JOB, day(-2))).toBe(0);
    expect(elapsedBps(ASSIGNED_JOB, day(30))).toBe(10_000);
  });

  it("floors, so a part-elapsed basis point never moves anyone to a worse tier", () => {
    // A boundary is crossed when a whole basis point has passed and not before.
    // On this window that is 86.4 seconds, and everything short of it is still
    // the tier the client was in — the quantisation falls their way, not ours.
    expect(elapsedBps(ASSIGNED_JOB, new Date(day(3).getTime() + 1))).toBe(3_000);
    expect(elapsedBps(ASSIGNED_JOB, new Date(day(3).getTime() + ONE_BPS_MS - 1))).toBe(3_000);
    expect(elapsedBps(ASSIGNED_JOB, new Date(day(3).getTime() + ONE_BPS_MS))).toBe(3_001);

    expect(cancellationTier(ASSIGNED_JOB, new Date(day(3).getTime() + ONE_BPS_MS - 1))).toBe(
      "early",
    );
  });

  it("treats a window of zero or less as fully elapsed, so a person looks at it", () => {
    const broken: JobTiming = {
      assignedAt: ASSIGNED,
      deadlineAt: ASSIGNED,
      hasDelivery: false,
    };

    expect(elapsedBps(broken, day(0))).toBe(10_000);
    expect(cancellationTier(broken, day(0))).toBe("late");
  });
});

describe("spec §5 row 1 — no worker assigned yet: full, instant, no fee", () => {
  const unassigned: JobTiming = {
    assignedAt: null,
    deadlineAt: DEADLINE,
    hasDelivery: false,
  };

  it("is the pre-assignment tier however long the job has been up", () => {
    expect(cancellationTier(unassigned, day(9))).toBe("pre_assignment");
  });

  it("charges no fee — an unmatched job is Zevi's failure, not the client's", () => {
    const quote = quoteCancellation({ budgetPaise: BUDGET, timing: unassigned, now: day(9) });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.feePaise).toBe(0);
    expect(quote.workerCompensationPaise).toBe(0);
    // Nothing was ever charged: payment happens at selection and there was none.
    expect(quote.clientRefundPaise).toBe(0);
  });
});

describe("spec §5 row 2 — ≤30% elapsed: full, minus ₹15", () => {
  it("covers the whole first three days of a ten-day window, boundary included", () => {
    expect(cancellationTier(ASSIGNED_JOB, day(0))).toBe("early");
    expect(cancellationTier(ASSIGNED_JOB, day(1))).toBe("early");
    expect(cancellationTier(ASSIGNED_JOB, day(3))).toBe("early");
  });

  it("returns the whole budget less ₹15, and pays the worker nothing", () => {
    const quote = quoteCancellation({ budgetPaise: BUDGET, timing: ASSIGNED_JOB, now: day(2) });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.feePaise).toBe(1_500); // ₹15
    expect(quote.workerCompensationPaise).toBe(0);
    expect(quote.clientRefundPaise).toBe(98_500); // ₹985
    expect(
      quote.clientRefundPaise + quote.workerCompensationPaise + quote.feePaise,
    ).toBe(BUDGET);
  });
});

describe("spec §5 row 3 — 31–50% elapsed: 80% client / 20% worker, minus ₹15", () => {
  it("starts once 30% is past and runs to half, boundary included", () => {
    expect(cancellationTier(ASSIGNED_JOB, new Date(day(3).getTime() + ONE_BPS_MS))).toBe("mid");
    expect(cancellationTier(ASSIGNED_JOB, day(4))).toBe("mid");
    expect(cancellationTier(ASSIGNED_JOB, day(5))).toBe("mid");
  });

  it("pays the worker 20% and returns the rest less ₹15", () => {
    const quote = quoteCancellation({ budgetPaise: BUDGET, timing: ASSIGNED_JOB, now: day(4) });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.workerCompensationPaise).toBe(20_000); // ₹200 — 20% of ₹1,000
    expect(quote.feePaise).toBe(1_500);
    expect(quote.clientRefundPaise).toBe(78_500); // ₹785 — 80% less the fee
    expect(
      quote.clientRefundPaise + quote.workerCompensationPaise + quote.feePaise,
    ).toBe(BUDGET);
  });
});

describe("spec §5 row 4 — >50% elapsed: admin assesses, client capped at 70%", () => {
  it("begins once half is past", () => {
    expect(cancellationTier(ASSIGNED_JOB, new Date(day(5).getTime() + ONE_BPS_MS))).toBe("late");
    expect(cancellationTier(ASSIGNED_JOB, day(9))).toBe("late");
  });

  it("quotes no figure — it quotes the ceiling a person may not go past", () => {
    const quote = quoteCancellation({ budgetPaise: BUDGET, timing: ASSIGNED_JOB, now: day(8) });

    expect(quote.kind).toBe("assessed");
    if (quote.kind !== "assessed") return;

    expect(quote.clientRefundCapBps).toBe(LATE_CLIENT_CAP_BPS);
    expect(quote.maxClientRefundPaise).toBe(70_000); // ₹700 of ₹1,000
  });
});

describe("spec §5 row 5 — after delivery: no percentage refund at all", () => {
  it("beats the clock, even on day one", () => {
    const delivered: JobTiming = { ...ASSIGNED_JOB, hasDelivery: true };

    expect(cancellationTier(delivered, day(1))).toBe("post_delivery");
    expect(quoteCancellation({ budgetPaise: BUDGET, timing: delivered, now: day(1) }).kind).toBe(
      "refused",
    );
  });

  it("beats an unassigned job too — the answer is still not a percentage", () => {
    // Not reachable: a delivery needs an active assignment. Asserted anyway
    // because the order of the two checks is the whole of this row.
    const odd: JobTiming = { assignedAt: null, deadlineAt: DEADLINE, hasDelivery: true };

    expect(cancellationTier(odd, day(1))).toBe("post_delivery");
  });
});

describe("the rounding rules exist so nobody is owed a negative number", () => {
  // ₹149 is the minimum a job may be posted at (spec §5), which makes it the
  // only place the ₹15 fee is a meaningful fraction of the budget.
  const MINIMUM = 14_900;

  it("keeps the client's refund positive at the ₹149 floor, early tier", () => {
    const quote = quoteCancellation({
      budgetPaise: MINIMUM,
      timing: ASSIGNED_JOB,
      now: day(1),
    });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.feePaise).toBe(CANCELLATION_FEE_PAISE);
    expect(quote.clientRefundPaise).toBe(13_400); // ₹134
  });

  it("floors the worker's share so the remainder falls to the client", () => {
    // 20% of ₹149 is ₹29.80 — 2980 paise exactly, so pick a budget that does
    // not divide: ₹149.99 would not be postable, so use ₹1,234.57.
    const quote = quoteCancellation({
      budgetPaise: 123_457,
      timing: ASSIGNED_JOB,
      now: day(4),
    });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.workerCompensationPaise).toBe(24_691); // floor(123457 × 0.2)
    expect(
      quote.clientRefundPaise + quote.workerCompensationPaise + quote.feePaise,
    ).toBe(123_457);
  });

  it("never lets the fee push a refund below zero", () => {
    // Not reachable through the product — the minimum budget is ₹149 — but the
    // clamp is what makes that a fact about the product rather than about luck.
    const quote = quoteCancellation({
      budgetPaise: 1_000,
      timing: ASSIGNED_JOB,
      now: day(1),
    });

    expect(quote.kind).toBe("immediate");
    if (quote.kind !== "immediate") return;

    expect(quote.clientRefundPaise).toBe(0);
    expect(quote.feePaise).toBe(1_000);
  });
});
