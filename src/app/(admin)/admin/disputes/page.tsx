import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/Alert";
import { loadDisputeQueue } from "@/lib/admin/disputes";
import { requireAdmin } from "@/lib/admin/session";
import { type DisputeQueueRow, isDisputeOutcome } from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatCountdown, formatDate } from "@/lib/utils/format";
import { formatPaise } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Disputes · Zevi" };

const DECIDED: Record<string, string> = {
  release: "Released to the worker.",
  refund: "Refunded to the client, and queued with the gateway.",
  split: "Split, and the client's share is queued with the gateway.",
};

/**
 * The dispute queue (spec §7, §11).
 *
 * Ordered by decision deadline, not by age: spec §11 gives five days to a
 * decision and stores the instant on the row, so "what is rotting" is a sort
 * and not a judgement.
 *
 * `view_disputes` opens this screen; `resolve_disputes` is what the case screen
 * checks before it renders the three buttons. The seeded `support` role holds
 * both, and the split exists so that a role which should only read cases can be
 * made later without touching either page.
 *
 * Empty at the moment, and honestly so: nothing on the platform raises a
 * dispute yet — spec §4's step 8 gives the client accept, revise or dispute, and
 * only the first two are built. The queue is here because the decision behind it
 * is, and because a dispute arriving before its queue does is the worse order to
 * build these in.
 */
export default async function DisputeQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string }>;
}) {
  await requireAdmin("view_disputes");
  const supabase = await createClient();

  const [{ decided }, queue] = await Promise.all([
    searchParams,
    loadDisputeQueue(supabase),
  ]);

  return (
    <div className="space-y-8">
      {decided && isDisputeOutcome(decided) ? (
        <Alert tone="success">{DECIDED[decided]}</Alert>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Disputes</h1>
        <p className="text-muted text-sm">
          {queue.length === 0
            ? "No case is waiting. Both sides can raise one from delivery until 48 hours after acceptance — that flow is not built yet, so nothing reaches here."
            : `${queue.length} waiting, closest to its decision deadline first.`}
        </p>
      </div>

      {queue.length === 0 ? null : (
        <ul className="space-y-3">
          {queue.map((row) => (
            <QueueEntry key={row.disputeId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueEntry({ row }: { row: DisputeQueueRow }) {
  const overdue = new Date(row.decisionDueAt).getTime() < Date.now();
  const awaitingFirstReply = row.firstRespondedAt === null;

  return (
    <li>
      <Link
        href={ADMIN_ROUTES.dispute(row.disputeId)}
        className={cn(
          "border-border hover:bg-surface-muted block space-y-2 rounded-xl border p-4 transition-colors sm:p-5",
          overdue && "border-danger/40 bg-danger/5",
        )}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-sm font-medium">{row.jobTitle}</p>
          <p className={cn("text-xs", overdue ? "text-danger" : "text-muted")}>
            Decision {formatCountdown(row.decisionDueAt)}
          </p>
        </div>

        <p className="text-muted line-clamp-2 text-sm">{row.reasonSummary}</p>

        <p className="text-muted text-xs">
          {formatPaise(row.amountPaise)} in dispute · raised by {row.raisedByName} (
          {row.raisedByRole}) on {formatDate(row.openedAt)} · {row.status.replace(/_/g, " ")}
          {awaitingFirstReply ? (
            <>
              {" "}
              · <span className="text-danger">first reply {formatCountdown(row.firstResponseDueAt)}</span>
            </>
          ) : null}
        </p>
      </Link>
    </li>
  );
}
