import type { Metadata } from "next";
import Link from "next/link";

import { adminCan, requireAnyAdmin } from "@/lib/admin/session";
import { loadWorkQueue } from "@/lib/admin/queue";
import type { QueueSummary } from "@/lib/admin/types";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatCountdown, formatDate, formatTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Work queue · Zevi" };

/**
 * Spec §7: "Home is a work queue, not a stats dashboard — ordered by what's
 * rotting: disputes past SLA, approvals nearing 24 hours, unassigned jobs about
 * to expire, failed payouts, flagged reports."
 *
 * All five are counted. Three of them lead somewhere; two — expiring jobs and
 * reports — are counts without a door, because spec §16 puts a job list and a
 * reports module in V1 and neither is built. A number with nowhere to click is
 * more useful than a tab that 404s and much more useful than silence: an
 * unread abuse report is exactly the thing this screen exists to stop being
 * invisible.
 *
 * The layout guard is membership, so every console role reaches this page.
 * What each one *sees* on it is decided per queue, from that account's
 * permissions — a support account gets disputes and reports and is not told how
 * many payouts failed.
 */
export default async function AdminHomePage() {
  await requireAnyAdmin();
  const supabase = await createClient();

  const [reviewWorkers, viewDisputes, manageUsers, managePayouts, resolveReports] =
    await Promise.all([
      adminCan("review_workers"),
      adminCan("view_disputes"),
      adminCan("manage_users"),
      adminCan("manage_payouts"),
      adminCan("resolve_reports"),
    ]);

  const queues = await loadWorkQueue(supabase, {
    reviewWorkers,
    viewDisputes,
    manageUsers,
    managePayouts,
    resolveReports,
  });

  const waiting = queues.reduce((total, queue) => total + queue.count, 0);
  const overdue = queues.reduce((total, queue) => total + queue.overdue, 0);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Work queue</h1>
        <p className="text-muted text-sm">
          {queues.length === 0
            ? "Your account is in the console but holds no permission that has a queue behind it yet."
            : waiting === 0
              ? "Nothing is waiting. Everything below is empty."
              : overdue > 0
                ? `${formatCount(waiting, "item")} waiting, ${overdue} past the deadline.`
                : `${formatCount(waiting, "item")} waiting, none overdue.`}
        </p>
      </div>

      {queues.length === 0 ? null : (
        <ul className="space-y-3">
          {queues.map((queue) => (
            <QueueCard key={queue.kind} queue={queue} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueCard({ queue }: { queue: QueueSummary }) {
  const empty = queue.count === 0;
  const late = queue.overdue > 0;

  const body = (
    <div
      className={cn(
        "border-border flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border p-4 sm:p-5",
        late && "border-danger/40 bg-danger/5",
        queue.href && "hover:bg-surface-muted transition-colors",
      )}
    >
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{queue.label}</p>
        <p className="text-muted text-xs">
          {empty ? queue.emptyNote : describe(queue)}
        </p>
      </div>

      <p
        className={cn(
          "shrink-0 text-2xl font-semibold tabular-nums",
          empty ? "text-muted" : late ? "text-danger" : "text-foreground",
        )}
      >
        {queue.count}
      </p>
    </div>
  );

  return (
    <li>
      {queue.href && !empty ? (
        <Link href={queue.href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

/**
 * What is actually urgent about this queue, in one line.
 *
 * The deadline leads, because it is the sort key and the thing a person acts
 * on. `formatCountdown` says "4h left" or "3h overdue" — a day is too coarse
 * for a 24-hour approval SLA and much too coarse for a payout that failed.
 */
function describe(queue: QueueSummary): string {
  const parts: string[] = [];

  if (queue.overdue > 0) {
    parts.push(
      queue.overdue === queue.count
        ? "all past the deadline"
        : `${queue.overdue} past the deadline`,
    );
  }

  if (queue.nextDueAt) {
    parts.push(
      queue.kind === "failed_payouts" || queue.kind === "reports"
        ? `oldest ${formatDate(queue.nextDueAt)}, ${formatTime(queue.nextDueAt)}`
        : `next ${formatCountdown(queue.nextDueAt)}`,
    );
  }

  return parts.length > 0 ? capitalise(parts.join(" · ")) : "Waiting.";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
