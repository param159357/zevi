/**
 * Server-side reads for the earnings screen — spec §6 "Earnings":
 *
 *   Pending → Confirmed → Paid. Next payout date shown prominently. Per-job
 *   breakdown with commission and tax as separate lines.
 *
 * Every query here runs under the worker's own Supabase client, so RLS is what
 * scopes it: `workers read their own earnings` (migration 0013) returns nothing
 * to anyone else, and 0031's `workers read the batches they are paid in` is what
 * lets the pay date come back with the payout rather than through a join a
 * worker is not allowed to make. The `worker_id` filter below makes the intent
 * readable; it is not what enforces it.
 *
 * Nothing here decides when money moves. The dates come off the row, stamped at
 * acceptance, and which cycle they fall into is `lib/payouts/cycle.ts` — one
 * calendar, the same one migration 0031 validates against.
 */

import { cycleFor } from "@/lib/payouts/cycle";
import { payableFrom } from "@/lib/payouts/eligibility";
import type {
  EarningLine,
  EarningTotals,
  EarningsOverview,
  NextRun,
  PayoutStatus,
} from "@/lib/payouts/types";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const EARNING_COLUMNS = `
  id, job_id, status, gross_paise, commission_paise, tax_paise, net_paise,
  accepted_at, eligible_at, hold_until, hold_reason,
  jobs ( title ),
  payouts ( id, status, paid_at, payout_batches ( scheduled_pay_at ) )
`;

/** PostgREST returns an embedded to-one as an object, or null. */
type Embedded<T> = T | null;

type EarningRow = {
  id: string;
  job_id: string;
  status: EarningLine["status"];
  gross_paise: number;
  commission_paise: number;
  tax_paise: number;
  net_paise: number;
  accepted_at: string | null;
  eligible_at: string | null;
  hold_until: string | null;
  hold_reason: string | null;
  jobs: Embedded<{ title: string | null }>;
  payouts: Embedded<{
    id: string;
    status: PayoutStatus;
    paid_at: string | null;
    payout_batches: Embedded<{ scheduled_pay_at: string }>;
  }>;
};

function toLine(row: EarningRow): EarningLine {
  return {
    id: row.id,
    jobId: row.job_id,
    // A job with no title cannot be published, so this only ever fires on a row
    // RLS trimmed — in which case the amount still belongs on the statement.
    jobTitle: row.jobs?.title?.trim() || "Completed job",
    status: row.status,
    grossPaise: row.gross_paise,
    commissionPaise: row.commission_paise,
    taxPaise: row.tax_paise,
    netPaise: row.net_paise,
    acceptedAt: row.accepted_at,
    eligibleAt: row.eligible_at,
    holdUntil: row.hold_until,
    holdReason: row.hold_reason,
    payout: row.payouts
      ? {
          id: row.payouts.id,
          status: row.payouts.status,
          paidAt: row.payouts.paid_at,
          scheduledPayAt: row.payouts.payout_batches?.scheduled_pay_at ?? null,
        }
      : null,
  };
}

/**
 * The six balances, kept apart on purpose.
 *
 * 0013 gave `worker_earnings` three separate columns for the three reasons money
 * can sit still so that a worker looking at an unpaid balance is owed the
 * specific reason rather than "processing". Collapsing them into one figure here
 * would throw that away at the last step.
 */
function totalsFor(lines: EarningLine[], now: Date): EarningTotals {
  const totals: EarningTotals = {
    maturingPaise: 0,
    payablePaise: 0,
    heldPaise: 0,
    inPayoutPaise: 0,
    frozenPaise: 0,
    paidPaise: 0,
  };

  for (const line of lines) {
    switch (line.status) {
      case "paid":
        totals.paidPaise += line.netPaise;
        break;
      case "in_payout":
        totals.inPayoutPaise += line.netPaise;
        break;
      case "frozen":
        totals.frozenPaise += line.netPaise;
        break;
      case "on_hold":
        totals.heldPaise += line.netPaise;
        break;
      case "confirmed": {
        // Confirmed splits by the clock, not by a column: inside the 48 hours it
        // is still maturing, past them it is in the next batch.
        const from = payableFrom(line);
        if (from !== null && from.getTime() <= now.getTime()) {
          totals.payablePaise += line.netPaise;
        } else {
          totals.maturingPaise += line.netPaise;
        }
        break;
      }
      // `pending` is pre-acceptance and `reversed`/`forfeited` are gone. None of
      // them is a balance the worker is owed, so none has a column here.
      default:
        break;
    }
  }

  return totals;
}

/**
 * The next run and what is riding on it — spec §6's "next payout date shown
 * prominently".
 *
 * Every earning that is not yet in a batch is asked which cycle would take it,
 * and the earliest such cycle wins. That is the *earliest* date the worker can
 * be told, which is the one worth showing: a held earning three cycles out does
 * not push the date of money that is payable on Friday.
 */
function nextRunFor(lines: EarningLine[]): NextRun | null {
  const waiting = lines.filter(
    (line) => line.payout === null && payableFrom(line) !== null,
  );

  if (waiting.length === 0) return null;

  let earliest: Date | null = null;

  for (const line of waiting) {
    const from = payableFrom(line);
    if (from === null) continue;

    const cutoff = cycleFor(from).cutoffAt;
    if (earliest === null || cutoff.getTime() < earliest.getTime()) earliest = cutoff;
  }

  if (earliest === null) return null;

  const cycle = cycleFor(earliest);
  const riding = waiting.filter((line) => {
    const from = payableFrom(line);
    return from !== null && from.getTime() <= cycle.cutoffAt.getTime();
  });

  return {
    cutoffAt: cycle.cutoffAt.toISOString(),
    scheduledPayAt: cycle.scheduledPayAt.toISOString(),
    closesLabel: cycle.closesLabel,
    paysLabel: cycle.paysLabel,
    amountPaise: riding.reduce((sum, line) => sum + line.netPaise, 0),
    jobCount: riding.length,
  };
}

export async function loadEarnings(
  supabase: ServerSupabaseClient,
  workerId: string,
  now: Date = new Date(),
): Promise<EarningsOverview> {
  const [earnings, methods] = await Promise.all([
    supabase
      .from("worker_earnings")
      .select(EARNING_COLUMNS)
      .eq("worker_id", workerId)
      .order("accepted_at", { ascending: false, nullsFirst: false }),
    supabase
      .from("payout_methods")
      .select("id")
      .eq("worker_id", workerId)
      .eq("status", "verified")
      .is("disabled_at", null)
      .limit(1),
  ]);

  if (earnings.error) {
    throw new Error(`could not read earnings: ${earnings.error.message}`);
  }

  // Not fatal. A worker who cannot be told whether their destination is verified
  // should still see what they have earned, and the copy degrades to the same
  // sentence an unverified worker gets.
  if (methods.error) {
    console.error(`[earnings] could not read payout methods: ${methods.error.message}`);
  }

  const lines = ((earnings.data ?? []) as unknown as EarningRow[]).map(toLine);

  return {
    lines,
    totals: totalsFor(lines, now),
    nextRun: nextRunFor(lines),
    canBePaid: (methods.data?.length ?? 0) > 0,
  };
}
