import { REFUND_STATUS_COPY, refundReasonLabel } from "@/lib/constants/refunds";
import type { RefundView } from "@/lib/refunds/types";
import { formatDate } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";

/**
 * Where a client's money got to — spec §14.
 *
 * A Server Component with no state, because there is nothing here to do. The
 * only honest actions on a refund are Zevi's, and offering a button that
 * re-tries one would be offering a client control over a queue that belongs to
 * the drain.
 *
 * Rendered on both screens a refund can be reached from — the client's review
 * of a cancelled job, and the dispute case either side reads — so the same
 * words describe the same row wherever it is found. The reason is spelled out
 * rather than left as its enum value: "dispute_split" is a log entry, not a
 * sentence.
 *
 * Nothing is shown when there is nothing to show. A job with no refunds renders
 * null rather than an empty panel saying so, because "no refunds" is the state
 * of almost every job on the platform.
 */
export function RefundPanel({ refunds }: { refunds: RefundView[] }) {
  if (refunds.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Your money back</h2>

      <ul className="border-border divide-border divide-y rounded-xl border">
        {refunds.map((refund) => {
          const copy = REFUND_STATUS_COPY[refund.status] ?? REFUND_STATUS_COPY.pending;

          return (
            <li key={refund.id} className="space-y-1.5 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="text-sm font-medium">{copy.label}</p>
                <p className="shrink-0 text-sm font-semibold tabular-nums">
                  {formatPaise(refund.amountPaise)}
                </p>
              </div>

              <p
                className={
                  copy.tone === "error"
                    ? "text-danger text-xs"
                    : copy.tone === "success"
                      ? "text-success text-xs"
                      : "text-muted text-xs"
                }
              >
                {copy.detail}
              </p>

              <p className="text-muted text-xs">
                {refundReasonLabel(refund.reason)} ·{" "}
                {refund.completedAt
                  ? `refunded ${formatDate(refund.completedAt)}`
                  : `started ${formatDate(refund.createdAt)}`}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
