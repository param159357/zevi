import type { WorkerJobWork } from "@/lib/deliveries/types";
import { formatDate } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";

/**
 * Spec §6: "Pending → Confirmed → Paid", with commission and tax as separate
 * lines. This is the Confirmed end of it — written by `accept_job_delivery()`
 * the moment the job completes.
 *
 * The three reasons money can sit still are three columns on `worker_earnings`
 * for exactly this: a worker looking at an unpaid balance is owed the specific
 * reason, not "processing".
 */
export function EarningSummary({ earning }: { earning: NonNullable<WorkerJobWork["earning"]> }) {
  return (
    <div className="border-border bg-surface-muted space-y-3 rounded-xl border p-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium">What you earned</h2>
        <span className="text-muted text-xs">{describeStatus(earning.status)}</span>
      </div>

      <dl className="space-y-2 text-sm">
        <Row label="Job budget" amount={earning.grossPaise} />
        <Row label="Zevi fee (your share)" amount={-earning.commissionPaise} />
        <Row label="GST on the fee" amount={-earning.taxPaise} />

        <div className="border-border flex items-baseline justify-between gap-4 border-t pt-2 font-medium">
          <dt>Yours</dt>
          <dd className="tabular-nums">{formatPaise(earning.netPaise)}</dd>
        </div>
      </dl>

      <p className="text-muted text-xs">{describeTiming(earning)}</p>
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

function describeStatus(status: NonNullable<WorkerJobWork["earning"]>["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "confirmed":
      return "Confirmed";
    case "on_hold":
      return "Held";
    case "frozen":
      return "Frozen";
    case "in_payout":
      return "In a payout";
    case "paid":
      return "Paid";
    case "reversed":
      return "Reversed";
    case "forfeited":
      return "Forfeited";
  }
}

/**
 * Payouts do not exist yet — no cycle runs, no money leaves the platform
 * account. Saying "next Friday" would be a promise nothing can keep, so this
 * says what is true: the amount is yours and the payout flow is not built.
 */
function describeTiming(earning: NonNullable<WorkerJobWork["earning"]>): string {
  if (earning.holdUntil) {
    return `${earning.holdReason ?? "Held"} — clear from ${formatDate(earning.holdUntil)}. Payouts aren't switched on yet, so nothing has been transferred.`;
  }

  if (earning.eligibleAt) {
    return `Matures ${formatDate(earning.eligibleAt)}, 48 hours after acceptance. Payouts aren't switched on yet, so nothing has been transferred.`;
  }

  return "Payouts aren't switched on yet, so nothing has been transferred.";
}
