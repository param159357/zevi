import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PayoutBatchForm } from "@/components/admin/PayoutBatchForm";
import { Alert } from "@/components/ui/Alert";
import { loadPayoutBatch } from "@/lib/admin/payouts";
import { requireAdmin } from "@/lib/admin/session";
import type { PayoutLine } from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDate } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Payout batch · Zevi" };

const REVIEWED: Record<string, string> = {
  approve: "Approved. It is marked reviewed and waiting on a disbursement step that is not built.",
  cancel:
    "Unbuilt. Those earnings are confirmed again and roll into the next cycle at the same place in the queue.",
};

/**
 * One batch, per spec §7's "batch review before each run".
 *
 * What a reviewer is actually checking, in the order the screen puts it:
 *
 *   * the total, against the count of workers — "₹48,000 across 96" is a
 *     healthy fortnight and "₹48,000 across 2" is a question
 *   * that every line has a verified destination, and when it was verified.
 *     `payouts.payout_method_id` is NOT NULL so a line without one cannot exist,
 *     but a destination verified an hour ago on a worker who joined yesterday is
 *     worth a second look
 *   * anything unusually large
 *
 * The destination is masked and there is nothing to unmask: 0033 keeps only the
 * last four digits and a keyed HMAC, so this is the whole of what was ever
 * stored.
 */
export default async function PayoutBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams: Promise<{ reviewed?: string }>;
}) {
  await requireAdmin("manage_payouts");

  const [{ batchId }, { reviewed }, supabase] = await Promise.all([
    params,
    searchParams,
    createClient(),
  ]);

  const batch = await loadPayoutBatch(supabase, batchId);

  if (!batch) notFound();

  const unverified = batch.lines.filter((line) => line.destinationVerifiedAt === null);

  return (
    <div className="space-y-8">
      {reviewed && REVIEWED[reviewed] ? (
        <Alert tone="success">{REVIEWED[reviewed]}</Alert>
      ) : null}

      <div className="space-y-2">
        <Link href={ADMIN_ROUTES.payouts} className="text-muted text-sm hover:underline">
          ← Payouts
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">
          {formatPaise(batch.totalPaise)}
        </h1>

        <p className="text-muted text-sm">
          Cycle closed {formatDate(batch.cutoffAt)} · pays {formatDate(batch.scheduledPayAt)} ·{" "}
          {batch.status.replace(/_/g, " ")}
          {batch.reviewedAt ? ` · reviewed ${formatDate(batch.reviewedAt)}` : ""}
        </p>

        <p className="text-muted text-sm">
          {formatCount(batch.payoutCount, "worker")} · {formatCount(batch.itemCount, "earning")}
        </p>
      </div>

      {batch.failureNote ? <Alert tone="error">{batch.failureNote}</Alert> : null}

      {unverified.length > 0 ? (
        <Alert tone="error">
          {formatCount(unverified.length, "line")} in this batch has a destination with no
          verification date. That should not be reachable — a payout requires a verified
          `payout_methods` row — so read it before approving.
        </Alert>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-medium tracking-tight">Lines</h2>

        {batch.lines.length === 0 ? (
          <p className="text-muted text-sm">
            This batch is empty. Every worker with mature earnings was skipped for want of a
            verified destination, and their money rolls into the next cycle untouched.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-xl border">
            {batch.lines.map((line) => (
              <LineRow key={line.payoutId} line={line} />
            ))}
          </ul>
        )}
      </section>

      {batch.status === "closed" ? (
        <section className="space-y-3">
          <div className="space-y-0.5">
            <h2 className="text-lg font-medium tracking-tight">Review</h2>
            <p className="text-muted text-xs">
              Approving marks it read and ready. It does not send anything — disbursement is not
              built, and the ledger still shows every rupee of this owed rather than paid.
            </p>
          </div>

          <PayoutBatchForm batchId={batch.id} />
        </section>
      ) : (
        <Alert tone="info">
          {batch.status === "open"
            ? "Still being filled — the per-run worker cap was hit and the next run carries on. It can be reviewed once a run closes it."
            : `This batch is ${batch.status.replace(/_/g, " ")} and is not open for review.`}
        </Alert>
      )}
    </div>
  );
}

function LineRow({ line }: { line: PayoutLine }) {
  const unverified = line.destinationVerifiedAt === null;

  return (
    <li
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3",
        unverified && "bg-danger/5",
      )}
    >
      <div className="min-w-0">
        <p className="truncate text-sm">{line.workerName}</p>
        <p className="text-muted truncate text-xs">
          {line.destination ?? "No destination on file"} ·{" "}
          {formatCount(line.itemCount, "job")} · {line.status}
          {line.destinationVerifiedAt
            ? ` · verified ${formatDate(line.destinationVerifiedAt)}`
            : " · never verified"}
        </p>
        {line.failureReason ? (
          <p className="text-danger text-xs">{line.failureReason}</p>
        ) : null}
      </div>

      <p className="shrink-0 text-sm font-semibold tabular-nums">
        {formatPaise(line.amountPaise)}
      </p>
    </li>
  );
}
