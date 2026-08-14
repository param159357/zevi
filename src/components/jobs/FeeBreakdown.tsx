import type { CommissionBreakdown } from "@/lib/money/commission";
import { formatBps, formatPaise, formatPaiseCompact } from "@/lib/utils/money";

/**
 * Spec §5: "Fee shown as a separate line, never hidden." Spec §8: GST is added
 * on top of the commission as its own line, never folded into it.
 *
 * So this is three lines and a total, always — even when the fee is small
 * enough that hiding it would be tempting.
 */
export function FeeBreakdown({ price }: { price: CommissionBreakdown }) {
  return (
    <div className="border-border bg-surface-muted space-y-3 rounded-xl border p-4">
      <dl className="space-y-2 text-sm">
        <Row label="Job budget" amount={price.budgetPaise} />
        <Row
          label={`Zevi fee (${formatBps(price.clientBps)})`}
          amount={price.clientCommissionPaise}
        />
        <Row
          label={`GST (${formatBps(price.taxRateBps)})`}
          amount={price.clientTaxPaise}
        />

        <div className="border-border flex items-baseline justify-between gap-4 border-t pt-2 font-medium">
          <dt>You&apos;ll pay</dt>
          <dd className="tabular-nums">{formatPaise(price.clientTotalPaise)}</dd>
        </div>
      </dl>

      <p className="text-muted text-xs">
        Nothing is charged now. Payment happens when you pick a worker, and it&apos;s
        held until you accept the work.
      </p>

      <p className="text-muted text-xs">
        The worker receives {formatPaise(price.workerNetPaise)} — their own{" "}
        {formatBps(price.workerBps)} share and GST come out of the budget.
        {price.floorApplied
          ? ` At this budget our fee sits at its ${formatPaiseCompact(price.commissionPaise)} minimum, split between you both.`
          : ""}
        {price.capApplied
          ? ` Our fee is capped at ${formatPaiseCompact(price.commissionPaise)} on a job this size.`
          : ""}
      </p>
    </div>
  );
}

function Row({ label, amount }: { label: string; amount: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums">{formatPaise(amount)}</dd>
    </div>
  );
}
