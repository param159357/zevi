import type { Metadata } from "next";
import Link from "next/link";

import { RetryPayoutForm } from "@/components/admin/PayoutBatchForm";
import { Alert } from "@/components/ui/Alert";
import {
  loadFailedPayouts,
  loadFinanceSnapshot,
  loadPayoutBatches,
} from "@/lib/admin/payouts";
import { requireAdmin } from "@/lib/admin/session";
import type { FailedPayoutRow, FinanceSnapshot, PayoutBatchRow } from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { cycleFor } from "@/lib/payouts/cycle";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDate, formatDateShort } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Payouts · Zevi" };

/**
 * Spec §7's Payouts module: "Escrow balance, batch review before each run,
 * failed-payout queue with retry."
 *
 * The escrow balance is summed from `ledger_account_balances` and never from a
 * column — 0011 is explicit that a stored balance some code path forgot to
 * update cannot answer the question a chargeback asks six months later, and an
 * admin screen quoting one is where that rot would first become invisible.
 *
 * The one number worth explaining is "waiting on KYC": `build_payout_batch()`
 * skips any worker with no verified `payout_methods` row and leaves their
 * earnings `confirmed` for the next cycle. That was every rupee on the platform
 * until KYC landed and is now a queue length — so it goes on screen rather than
 * being discoverable only from a cron log.
 */
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ retried?: string }>;
}) {
  await requireAdmin("manage_payouts");
  const supabase = await createClient();

  const [{ retried }, snapshot, batches, failed] = await Promise.all([
    searchParams,
    loadFinanceSnapshot(supabase),
    loadPayoutBatches(supabase),
    loadFailedPayouts(supabase),
  ]);

  const next = cycleFor(new Date());
  const awaitingReview = batches.filter((batch) => batch.status === "closed");

  return (
    <div className="space-y-8">
      {retried ? (
        <Alert tone="success">
          Returned to the cycle. Those earnings are confirmed again and the next batch will pick
          them up — if the worker&rsquo;s destination is verified by then.
        </Alert>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Payouts</h1>
        <p className="text-muted text-sm">
          Next cycle closes {next.closesLabel} midnight —{" "}
          {formatDateShort(next.cutoffAt.toISOString())} — and pays{" "}
          {formatDateShort(next.scheduledPayAt.toISOString())}.
        </p>
      </div>

      <Money snapshot={snapshot} />

      <Alert tone="info">
        Nothing on this screen sends money. Razorpay&rsquo;s payout API is not wired, so a batch
        assembles, is reviewed here, and stops — the ledger still shows the platform owing every
        rupee of it, which is exactly right.
      </Alert>

      <section className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="text-lg font-medium tracking-tight">Batches</h2>
          <p className="text-muted text-xs">
            {awaitingReview.length === 0
              ? "None waiting on a review."
              : `${formatCount(awaitingReview.length, "batch", "batches")} waiting on a review.`}
          </p>
        </div>

        {batches.length === 0 ? (
          <p className="text-muted text-sm">
            No batch has been built yet. The payout cron runs daily at 01:00 IST and finds a
            cutoff to close twice a week.
          </p>
        ) : (
          <ul className="space-y-3">
            {batches.map((batch) => (
              <BatchRow key={batch.id} batch={batch} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <div className="space-y-0.5">
          <h2 className="text-lg font-medium tracking-tight">Failed payouts</h2>
          <p className="text-muted text-xs">
            Spec §14: money returns to escrow, and the retry is the earnings going back into the
            next cycle rather than a second attempt at the same transfer.
          </p>
        </div>

        {failed.length === 0 ? (
          <p className="text-muted text-sm">
            Nothing has failed. Nothing has been sent either — disbursement is not built.
          </p>
        ) : (
          <ul className="space-y-3">
            {failed.map((row) => (
              <FailedRow key={row.payoutId} row={row} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Money({ snapshot }: { snapshot: FinanceSnapshot }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Figure
        label="In escrow"
        value={formatPaise(snapshot.escrowPaise)}
        note="Clients' money held against live jobs."
      />
      <Figure
        label="Owed to workers"
        value={formatPaise(snapshot.workerPayablePaise)}
        note="Released from escrow, not yet paid out."
      />
      <Figure
        label="Ready for the next run"
        value={formatPaise(snapshot.awaitingPayoutPaise)}
        note="Confirmed, matured, not in a batch."
      />
      <Figure
        label="Waiting on KYC"
        value={formatPaise(snapshot.blockedOnKycPaise)}
        note="Ready, but the worker has no verified destination."
        alarming={snapshot.blockedOnKycPaise > 0}
      />
      <Figure
        label="Platform revenue"
        value={formatPaise(snapshot.platformRevenuePaise)}
        note="Commission recognised at capture and at acceptance."
      />
      <Figure
        label="GST payable"
        value={formatPaise(snapshot.taxPayablePaise)}
        note="Collected, owed onward. Never revenue."
      />
    </dl>
  );
}

function Figure({
  label,
  value,
  note,
  alarming = false,
}: {
  label: string;
  value: string;
  note: string;
  alarming?: boolean;
}) {
  return (
    <div className={cn("border-border rounded-xl border p-4", alarming && "border-danger/40")}>
      <dt className="text-muted text-xs">{label}</dt>
      <dd className={cn("mt-1 text-xl font-semibold tabular-nums", alarming && "text-danger")}>
        {value}
      </dd>
      <p className="text-muted mt-1 text-xs">{note}</p>
    </div>
  );
}

function BatchRow({ batch }: { batch: PayoutBatchRow }) {
  const needsReview = batch.status === "closed";

  return (
    <li>
      <Link
        href={ADMIN_ROUTES.payoutBatch(batch.id)}
        className={cn(
          "border-border hover:bg-surface-muted flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 rounded-xl border p-4 transition-colors",
          needsReview && "border-accent/50",
        )}
      >
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            Pays {formatDate(batch.scheduledPayAt)} · {batch.status.replace(/_/g, " ")}
          </p>
          <p className="text-muted text-xs">
            Closed {formatDate(batch.cutoffAt)} · {formatCount(batch.payoutCount, "worker")} ·{" "}
            {formatCount(batch.itemCount, "earning")}
            {batch.reviewedAt ? ` · reviewed ${formatDate(batch.reviewedAt)}` : ""}
          </p>
          {batch.failureNote ? (
            <p className="text-danger text-xs">{batch.failureNote}</p>
          ) : null}
        </div>

        <p className="shrink-0 text-lg font-semibold tabular-nums">
          {formatPaise(batch.totalPaise)}
        </p>
      </Link>
    </li>
  );
}

function FailedRow({ row }: { row: FailedPayoutRow }) {
  return (
    <li className="border-danger/40 bg-danger/5 space-y-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{row.workerName}</p>
          <p className="text-muted text-xs">
            Attempt {row.attempt}
            {row.failedAt ? ` · failed ${formatDate(row.failedAt)}` : ""}
            {row.batchPayAt ? ` · was due ${formatDate(row.batchPayAt)}` : ""}
          </p>
        </div>
        <p className="shrink-0 text-sm font-semibold tabular-nums">
          {formatPaise(row.amountPaise)}
        </p>
      </div>

      {row.failureReason ? (
        <p className="text-sm">
          {row.failureReason}
          {row.failureCode ? ` (${row.failureCode})` : ""}
        </p>
      ) : null}

      <RetryPayoutForm payoutId={row.payoutId} />
    </li>
  );
}
