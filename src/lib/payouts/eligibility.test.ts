import { describe, expect, it } from "vitest";

import {
  ELIGIBILITY_HOURS,
  NEW_CLIENT_HOLD_DAYS,
  PAY_RUN_HOUR_IST,
} from "@/lib/constants/payouts";
import {
  closedCycleAt,
  cutoffOnOrAfter,
  cutoffOnOrBefore,
  cycleFor,
  cycleForCutoff,
  isCutoffInstant,
} from "@/lib/payouts/cycle";
import {
  type EarningTiming,
  isPayableAtCutoff,
  payableFrom,
  payoutRunFor,
} from "@/lib/payouts/eligibility";

/**
 * SPEC §6 "Payouts", checked against a real fortnight of the calendar.
 *
 *   Twice weekly. Cycle closes Wednesday midnight → paid Friday. Closes Sunday
 *   midnight → paid Tuesday.
 *
 *   Eligibility: client acceptance (or auto-accept) plus 48 hours before the
 *   cycle cutoff. Anything short rolls forward.
 *
 *   New client exception: worker payout held 14 days for a new client's first 3
 *   jobs (chargeback protection).
 *
 * Those three paragraphs are the whole specification of this module, and the
 * reason the dates below are hardcoded rather than derived is the same reason
 * `commission.test.ts` hardcodes the slabs: a test that computes its expectation
 * the way the code does proves only that the code is self-consistent. August
 * 2026 is written out here as an ordinary week — Wed 12, Thu 13, Fri 14, Sun 16,
 * Mon 17, Tue 18 — and every assertion names the weekday it is really about.
 *
 * The one genuinely ambiguous phrase in the spec is "closes Wednesday midnight",
 * and the first block below is where it is pinned: the midnight that *ends*
 * Wednesday, so work accepted during Wednesday is in Friday's run.
 */

/** An IST wall-clock moment, 1-based month, as the instant it names. */
function ist(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - 330 * 60_000);
}

/** A UTC moment, for the handful of assertions that are about the offset. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// The four cutoffs of the fortnight everything below is set in.
const THU_13 = ist(2026, 8, 13); // closes Wed 12 → pays Fri 14
const MON_17 = ist(2026, 8, 17); // closes Sun 16 → pays Tue 18
const THU_20 = ist(2026, 8, 20); // closes Wed 19 → pays Fri 21
const MON_24 = ist(2026, 8, 24); // closes Sun 23 → pays Tue 25

/**
 * What `accept_job_delivery()` stamps on a `worker_earnings` row (migration
 * 0030), restated so these tests run against realistic rows rather than
 * hand-picked timestamps:
 *
 *     eligible_at = now() + payout.eligibility_hours     (48 hours)
 *     hold_until  = now() + payout.new_client_hold_days  (14 days), and the
 *                   status starts `on_hold`, only when the client had fewer
 *                   than three completed jobs
 */
function acceptedAt(
  instant: Date,
  options: { newClient?: boolean; status?: EarningTiming["status"] } = {},
): EarningTiming {
  const newClient = options.newClient ?? false;

  return {
    status: options.status ?? (newClient ? "on_hold" : "confirmed"),
    eligibleAt: new Date(instant.getTime() + ELIGIBILITY_HOURS * HOUR_MS),
    holdUntil: newClient ? new Date(instant.getTime() + NEW_CLIENT_HOLD_DAYS * DAY_MS) : null,
  };
}

describe('"closes Wednesday midnight" is the midnight that ends Wednesday', () => {
  it("puts the cutoff at Thursday 00:00 IST", () => {
    expect(isCutoffInstant(THU_13)).toBe(true);
    expect(isCutoffInstant(MON_17)).toBe(true);
  });

  it("counts work accepted during Wednesday into the cycle closing that night", () => {
    // The reading this rules out: a cutoff at the *start* of Wednesday, which
    // would mean nothing happening on Wednesday made Wednesday's cycle.
    expect(cutoffOnOrAfter(ist(2026, 8, 12, 23, 59))).toEqual(THU_13);
    expect(cutoffOnOrAfter(ist(2026, 8, 12, 0, 1))).toEqual(THU_13);
  });

  it("rejects every other midnight, and every other time on the right day", () => {
    expect(isCutoffInstant(ist(2026, 8, 12))).toBe(false); // Wednesday 00:00
    expect(isCutoffInstant(ist(2026, 8, 14))).toBe(false); // Friday 00:00
    expect(isCutoffInstant(ist(2026, 8, 16))).toBe(false); // Sunday 00:00
    expect(isCutoffInstant(ist(2026, 8, 13, 0, 1))).toBe(false); // a minute late
    expect(isCutoffInstant(ist(2026, 8, 13, 11))).toBe(false); // Thursday, but daytime
  });

  it("is midnight in IST, not in UTC", () => {
    // Thursday 00:00 IST is Wednesday 18:30 UTC. A server that reasoned in UTC
    // would close the cycle five and a half hours late and pay a day of work
    // into the wrong run.
    expect(THU_13.toISOString()).toBe("2026-08-12T18:30:00.000Z");
    expect(isCutoffInstant(utc(2026, 8, 13))).toBe(false);
  });
});

describe("the two cycles and what they pay", () => {
  it("closes Wednesday and pays Friday", () => {
    const cycle = cycleForCutoff(THU_13);

    expect(cycle.closesLabel).toBe("Wednesday");
    expect(cycle.paysLabel).toBe("Friday");
    expect(cycle.scheduledPayAt).toEqual(ist(2026, 8, 14, PAY_RUN_HOUR_IST));
  });

  it("closes Sunday and pays Tuesday", () => {
    const cycle = cycleForCutoff(MON_17);

    expect(cycle.closesLabel).toBe("Sunday");
    expect(cycle.paysLabel).toBe("Tuesday");
    expect(cycle.scheduledPayAt).toEqual(ist(2026, 8, 18, PAY_RUN_HOUR_IST));
  });

  it("runs each cycle from the previous cutoff, unequal on purpose", () => {
    // Twice a week on fixed weekdays cannot be evenly spaced: Thursday to Monday
    // is four days, Monday to Thursday is three.
    expect(cycleForCutoff(MON_17).cycleStartAt).toEqual(THU_13);
    expect(cycleForCutoff(THU_20).cycleStartAt).toEqual(MON_17);

    expect(MON_17.getTime() - THU_13.getTime()).toBe(4 * DAY_MS);
    expect(THU_20.getTime() - MON_17.getTime()).toBe(3 * DAY_MS);
  });

  it("refuses to describe a cycle around an instant that is not a cutoff", () => {
    // Rounding to a nearby cutoff would be a payout on the wrong day.
    expect(() => cycleForCutoff(ist(2026, 8, 14))).toThrow(/not a payout cutoff/);
  });

  it("crosses a year end without special-casing it", () => {
    // Wednesday 30 Dec 2026 closes at Thursday 31 Dec 00:00 IST, paying Friday
    // 1 Jan 2027.
    const cycle = cycleFor(ist(2026, 12, 30, 15));

    expect(cycle.cutoffAt).toEqual(ist(2026, 12, 31));
    expect(cycle.scheduledPayAt).toEqual(ist(2027, 1, 1, PAY_RUN_HOUR_IST));
    expect(cycle.paysLabel).toBe("Friday");
  });
});

describe("finding the cycle around an instant", () => {
  it("takes the cutoff it lands exactly on", () => {
    // The boundary is inclusive, matching the builder's `eligible_at <= cutoff`.
    expect(cutoffOnOrAfter(THU_13)).toEqual(THU_13);
    expect(cutoffOnOrBefore(THU_13)).toEqual(THU_13);
  });

  it("rolls a millisecond past the cutoff into the next cycle", () => {
    expect(cutoffOnOrAfter(new Date(THU_13.getTime() + 1))).toEqual(MON_17);
  });

  it("finds the closed cycle the cron should be building", () => {
    // Friday morning, the run that closed on Thursday is the one to build.
    expect(closedCycleAt(ist(2026, 8, 14, 11)).cutoffAt).toEqual(THU_13);
    // Still true on Sunday: Monday's cutoff has not arrived.
    expect(closedCycleAt(ist(2026, 8, 16, 23)).cutoffAt).toEqual(THU_13);
    // Monday morning it moves on.
    expect(closedCycleAt(ist(2026, 8, 17, 1)).cutoffAt).toEqual(MON_17);
  });
});

describe("eligibility: acceptance plus 48 hours before the cutoff", () => {
  it("pays on Friday when the 48 hours land before Thursday's cutoff", () => {
    // Accepted Monday 09:00 → mature Wednesday 09:00 → inside the cycle that
    // closes on Wednesday night.
    const earning = acceptedAt(ist(2026, 8, 10, 9));

    expect(payableFrom(earning)).toEqual(ist(2026, 8, 12, 9));
    expect(isPayableAtCutoff(earning, THU_13)).toBe(true);
    expect(payoutRunFor(earning)?.scheduledPayAt).toEqual(ist(2026, 8, 14, PAY_RUN_HOUR_IST));
  });

  it("rolls forward when the 48 hours are short of the cutoff", () => {
    // Accepted Wednesday 10:00 → mature Friday 10:00, after Thursday's cutoff.
    // Spec: "anything short rolls forward" — so it waits for Sunday's close and
    // is paid on Tuesday, not on Friday alongside work accepted a day earlier.
    const earning = acceptedAt(ist(2026, 8, 12, 10));

    expect(payableFrom(earning)).toEqual(ist(2026, 8, 14, 10));
    expect(isPayableAtCutoff(earning, THU_13)).toBe(false);
    expect(isPayableAtCutoff(earning, MON_17)).toBe(true);

    const run = payoutRunFor(earning);
    expect(run?.paysLabel).toBe("Tuesday");
    expect(run?.scheduledPayAt).toEqual(ist(2026, 8, 18, PAY_RUN_HOUR_IST));
  });

  it("counts 48 hours landing exactly on the cutoff as in", () => {
    // Accepted Tuesday 00:00 → mature Thursday 00:00, the cutoff instant itself.
    // Inclusive, because the alternative costs a worker four days over a
    // rounding convention.
    const onTime = acceptedAt(ist(2026, 8, 11));

    expect(payableFrom(onTime)).toEqual(THU_13);
    expect(isPayableAtCutoff(onTime, THU_13)).toBe(true);
    expect(payoutRunFor(onTime)?.paysLabel).toBe("Friday");

    // One minute later and it is Monday's cycle.
    const late = acceptedAt(ist(2026, 8, 11, 0, 1));

    expect(isPayableAtCutoff(late, THU_13)).toBe(false);
    expect(payoutRunFor(late)?.paysLabel).toBe("Tuesday");
  });

  it("keeps rolling forward rather than expiring", () => {
    // A cron that fails for a week pays late, never short: the builder selects
    // everything mature, not everything mature since the last run, so the same
    // earning is still there two cutoffs later.
    const earning = acceptedAt(ist(2026, 8, 12, 10));

    expect(isPayableAtCutoff(earning, THU_13)).toBe(false);
    expect(isPayableAtCutoff(earning, MON_17)).toBe(true);
    expect(isPayableAtCutoff(earning, THU_20)).toBe(true);
    expect(isPayableAtCutoff(earning, MON_24)).toBe(true);
  });
});

describe("the 14-day hold on a new client's first three jobs", () => {
  it("holds past the maturity that would otherwise have paid on Friday", () => {
    // Accepted Monday 10 Aug 09:00. Mature Wednesday 12th — Friday's run — but
    // the client is new, so the chargeback window runs to Monday 24th and the
    // first cutoff after that is Thursday 27th, paying Friday 28th.
    const held = acceptedAt(ist(2026, 8, 10, 9), { newClient: true });

    expect(payableFrom(held)).toEqual(ist(2026, 8, 24, 9));

    expect(isPayableAtCutoff(held, THU_13)).toBe(false);
    expect(isPayableAtCutoff(held, MON_24)).toBe(false); // the hold clears at 09:00, nine hours late
    expect(isPayableAtCutoff(held, ist(2026, 8, 27))).toBe(true);

    expect(payoutRunFor(held)?.scheduledPayAt).toEqual(ist(2026, 8, 28, PAY_RUN_HOUR_IST));
  });

  it("pays the same work two weeks earlier for an established client", () => {
    // The hold is about the client's history, not the worker's. Same worker,
    // same job, same instant — the only difference is who paid for it.
    const sameInstant = ist(2026, 8, 10, 9);

    expect(payoutRunFor(acceptedAt(sameInstant))?.scheduledPayAt).toEqual(
      ist(2026, 8, 14, PAY_RUN_HOUR_IST),
    );
    expect(payoutRunFor(acceptedAt(sameInstant, { newClient: true }))?.scheduledPayAt).toEqual(
      ist(2026, 8, 28, PAY_RUN_HOUR_IST),
    );
  });

  it("takes the later of the two delays, never their sum", () => {
    // Both must have passed, so it is a max. Adding them would hold a new
    // client's job 16 days instead of 14.
    const held = acceptedAt(ist(2026, 8, 10, 9), { newClient: true });

    expect(payableFrom(held)).toEqual(new Date(ist(2026, 8, 10, 9).getTime() + 14 * DAY_MS));
  });

  it("falls back to the maturity when a hold is set shorter than it", () => {
    // 14 days beats 48 hours today, but both numbers are settings. A `max` stays
    // right if they ever cross; a "hold wins if present" rule would not.
    const earning: EarningTiming = {
      status: "on_hold",
      eligibleAt: ist(2026, 8, 12, 9),
      holdUntil: ist(2026, 8, 11, 9),
    };

    expect(payableFrom(earning)).toEqual(ist(2026, 8, 12, 9));
  });

  it("includes a hold expiring exactly on a cutoff", () => {
    const earning: EarningTiming = {
      status: "on_hold",
      eligibleAt: ist(2026, 8, 10),
      holdUntil: THU_13,
    };

    expect(isPayableAtCutoff(earning, THU_13)).toBe(true);
  });
});

describe("which statuses money can come out of", () => {
  const timings = { eligibleAt: ist(2026, 8, 10), holdUntil: null } as const;

  it("pays confirmed and on_hold earnings", () => {
    // `on_hold` counts here and not in the builder's WHERE clause, and that is
    // the documented seam: the builder releases matured holds to `confirmed`
    // before it selects, while this module is read by a dashboard that has to
    // say "your held earning pays on Friday" before the release has run. The
    // `hold_until <= cutoff` test is what decides it in both places.
    expect(payableFrom({ ...timings, status: "confirmed" })).not.toBeNull();
    expect(payableFrom({ ...timings, status: "on_hold" })).not.toBeNull();
  });

  it("never pays a frozen earning", () => {
    // A dispute or a chargeback investigation. Paying out of it would settle the
    // argument in one party's favour by default.
    expect(payableFrom({ ...timings, status: "frozen" })).toBeNull();
    expect(isPayableAtCutoff({ ...timings, status: "frozen" }, MON_24)).toBe(false);
    expect(payoutRunFor({ ...timings, status: "frozen" })).toBeNull();
  });

  it("never pays an earning that is already decided", () => {
    expect(payableFrom({ ...timings, status: "in_payout" })).toBeNull();
    expect(payableFrom({ ...timings, status: "paid" })).toBeNull();
    expect(payableFrom({ ...timings, status: "reversed" })).toBeNull();
    expect(payableFrom({ ...timings, status: "forfeited" })).toBeNull();
  });

  it("never pays an earning with no maturity stamp", () => {
    // `pending` is the pre-acceptance state: no `eligible_at`, nothing owed yet.
    expect(payableFrom({ status: "pending", eligibleAt: null, holdUntil: null })).toBeNull();
    expect(payableFrom({ status: "confirmed", eligibleAt: null, holdUntil: null })).toBeNull();
  });
});

describe("the timestamps as they actually arrive", () => {
  it("accepts ISO strings from PostgREST as readily as Dates", () => {
    // Supabase hands back `timestamptz` as a string; the dashboard passes rows
    // through untouched.
    const fromDatabase: EarningTiming = {
      status: "confirmed",
      eligibleAt: "2026-08-12T03:30:00+00:00",
      holdUntil: null,
    };

    expect(payableFrom(fromDatabase)).toEqual(ist(2026, 8, 12, 9));
    expect(payoutRunFor(fromDatabase)?.paysLabel).toBe("Friday");
  });

  it("treats an unparseable timestamp as no timestamp", () => {
    expect(payableFrom({ status: "confirmed", eligibleAt: "not a date", holdUntil: null })).toBeNull();
  });
});
