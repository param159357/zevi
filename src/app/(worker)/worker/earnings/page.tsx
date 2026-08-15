import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { ELIGIBILITY_HOURS } from "@/lib/constants/payouts";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { cycleFor } from "@/lib/payouts/cycle";
import { payableFrom } from "@/lib/payouts/eligibility";
import { loadEarnings } from "@/lib/payouts/queries";
import type { EarningLine, EarningTotals } from "@/lib/payouts/types";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateShort } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Your earnings · Zevi" };

/**
 * Spec §6 "Earnings": Pending → Confirmed → Paid, next payout date shown
 * prominently, per-job breakdown with commission and tax as separate lines.
 *
 * The date at the top is the whole point of the screen. It is computed from the
 * stamps `accept_job_delivery()` wrote at acceptance — never re-derived from
 * today's settings — so it does not move under a worker who has already read it.
 */
export default async function WorkerEarningsPage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const { lines, totals, nextRun, canBePaid } = await loadEarnings(supabase, context.user.id);

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your earnings</h1>
        <p className="text-muted text-sm">
          Payouts run twice a week. A cycle closes Wednesday midnight and pays Friday, and
          closes Sunday midnight and pays Tuesday.
        </p>
      </div>

      {nextRun ? (
        <div className="border-border bg-surface-muted space-y-1 rounded-xl border p-5">
          <p className="text-muted text-xs">Next payout</p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatPaise(nextRun.amountPaise)}
          </p>
          <p className="text-sm">
            {nextRun.paysLabel} {formatDate(nextRun.scheduledPayAt)} — {nextRun.jobCount}{" "}
            {nextRun.jobCount === 1 ? "job" : "jobs"}, from the cycle closing{" "}
            {nextRun.closesLabel} night.
          </p>
        </div>
      ) : null}

      {/*
        The honest version of "why hasn't this arrived". Spec §6 puts KYC before
        the first payout rather than at signup, and it is not built — so rather
        than showing a date nothing can keep, the screen says what is actually
        in the way. Everything already earned keeps rolling into the next cycle
        until it can be sent.
      */}
      {lines.length > 0 && !canBePaid ? (
        <Alert tone="info">
          We can&apos;t send money yet — bank verification isn&apos;t switched on, so no
          payout destination has been confirmed for your account. Your earnings stay yours
          and roll into the next cycle; nothing expires.
        </Alert>
      ) : null}

      {lines.length === 0 ? (
        <div className="border-border space-y-3 rounded-xl border border-dashed px-4 py-8 text-center">
          <p className="text-muted text-sm">
            Nothing yet. An earning opens the moment a client accepts your delivery.
          </p>
          <Link
            href={WORKER_ROUTES.feed}
            className="text-foreground inline-block text-sm underline underline-offset-4"
          >
            Browse open jobs
          </Link>
        </div>
      ) : (
        <>
          <Balances totals={totals} />

          <section className="space-y-3">
            <h2 className="text-sm font-medium">Job by job</h2>

            <ul className="border-border divide-border divide-y rounded-xl border">
              {lines.map((line) => (
                <li key={line.id} className="space-y-3 px-4 py-4">
                  <div className="flex items-baseline justify-between gap-4">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium">
                      {line.jobTitle}
                    </p>
                    <span className="text-muted shrink-0 text-xs">{statusLabel(line)}</span>
                  </div>

                  {/* Spec §8 and the law: commission and GST are separate visible
                      lines, never folded into a total. */}
                  <dl className="space-y-1.5 text-sm">
                    <Row label="Job budget" amount={line.grossPaise} />
                    <Row label="Zevi fee (your share)" amount={-line.commissionPaise} />
                    <Row label="GST on the fee" amount={-line.taxPaise} />
                    <div className="border-border flex items-baseline justify-between gap-4 border-t pt-1.5 font-medium">
                      <dt>Yours</dt>
                      <dd className="tabular-nums">{formatPaise(line.netPaise)}</dd>
                    </div>
                  </dl>

                  <p className="text-muted text-xs">{describeTiming(line, canBePaid)}</p>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Row({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">
        {amount < 0 ? `− ${formatPaise(-amount)}` : formatPaise(amount)}
      </dd>
    </div>
  );
}

/**
 * Five balances rather than one, because 0013 kept the three reasons money can
 * sit still in three columns for exactly this: a worker looking at an unpaid
 * balance is owed the specific reason, not "processing". A zero balance is not
 * rendered — an empty "Frozen ₹0.00" invents a worry.
 */
function Balances({ totals }: { totals: EarningTotals }) {
  const tiles = [
    { label: "In the next payout", amount: totals.payablePaise },
    { label: `Maturing (${ELIGIBILITY_HOURS}h)`, amount: totals.maturingPaise },
    { label: "Held", amount: totals.heldPaise },
    { label: "Being paid", amount: totals.inPayoutPaise },
    { label: "Frozen", amount: totals.frozenPaise },
    { label: "Paid out", amount: totals.paidPaise },
  ].filter((tile) => tile.amount > 0);

  if (tiles.length === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="border-border space-y-1 rounded-xl border p-4">
          <dt className="text-muted text-xs">{tile.label}</dt>
          <dd className="text-lg font-medium tabular-nums">{formatPaise(tile.amount)}</dd>
        </div>
      ))}
    </dl>
  );
}

function statusLabel(line: EarningLine): string {
  switch (line.status) {
    case "pending":
      return "Pending";
    case "confirmed": {
      const from = payableFrom(line);
      return from !== null && from.getTime() <= Date.now() ? "Ready" : "Maturing";
    }
    case "on_hold":
      return "Held";
    case "frozen":
      return "Frozen";
    case "in_payout":
      return "Being paid";
    case "paid":
      return "Paid";
    case "reversed":
      return "Reversed";
    case "forfeited":
      return "Forfeited";
  }
}

/**
 * One sentence saying where this money is and what moves it next. Every branch
 * names the specific thing being waited on — a date, a hold, an investigation —
 * because "processing" is what a worker chasing an unpaid balance already
 * suspects and cannot act on.
 */
function describeTiming(line: EarningLine, canBePaid: boolean): string {
  if (line.status === "paid") {
    return line.payout?.paidAt ? `Paid ${formatDate(line.payout.paidAt)}.` : "Paid.";
  }

  if (line.status === "in_payout") {
    return line.payout?.scheduledPayAt
      ? `In the batch scheduled for ${formatDate(line.payout.scheduledPayAt)}.`
      : "In the next batch.";
  }

  if (line.status === "frozen") {
    return "Frozen while a dispute or chargeback on this job is looked at. Nothing is lost while it is open.";
  }

  if (line.status === "reversed" || line.status === "forfeited") {
    return "No longer payable.";
  }

  const from = payableFrom(line);

  if (from === null) {
    return "Opens when the client accepts your delivery.";
  }

  // The two waits, named separately — the second is about the client's history,
  // not about the worker, and the copy should not let it read as suspicion.
  const wait =
    line.holdUntil && new Date(line.holdUntil).getTime() > Date.now()
      ? `Held until ${formatDate(line.holdUntil)} — a new client's first jobs wait out the chargeback window.`
      : from.getTime() > Date.now()
        ? `Clears ${formatDateShort(from.toISOString())}, ${ELIGIBILITY_HOURS} hours after acceptance.`
        : "Cleared and waiting for the next cycle.";

  // The pay date is only added where it is a date we can keep. Without a
  // verified destination the banner above has already said why, and repeating a
  // "pays Friday" on every line would be the promise that banner exists to
  // avoid making.
  if (!canBePaid) return wait;

  const run = cycleFor(from);

  return `${wait} Due in the run that pays ${run.paysLabel} ${formatDate(run.scheduledPayAt.toISOString())}.`;
}
