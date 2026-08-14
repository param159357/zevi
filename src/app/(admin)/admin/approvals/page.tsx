import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/Alert";
import { loadApprovalQueue } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { isReviewDecision } from "@/lib/admin/types";
import { ADMIN_ROUTES, APPROVAL_SLA_HOURS } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatCountdown, formatDate, formatTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Worker approvals · Zevi" };

const DECIDED: Record<string, string> = {
  approve: "Approved. They can see jobs in their categories now.",
  approve_with_flag: "Approved with a flag — their first delivery is worth watching.",
  reject: "Rejected. They can replace their samples and try once more in seven days.",
};

/**
 * The approval queue (spec §6, §7): 24-hour SLA, ordered by what breaches
 * first. Backed by the partial index on `sla_due_at` that migration 0005
 * created for exactly this read.
 */
export default async function ApprovalQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ reviewed?: string }>;
}) {
  await requireAdmin("review_workers");
  const supabase = await createClient();

  const [{ reviewed }, queue] = await Promise.all([
    searchParams,
    loadApprovalQueue(supabase),
  ]);

  return (
    <div className="space-y-8">
      {reviewed && isReviewDecision(reviewed) ? (
        <Alert tone="success">{DECIDED[reviewed]}</Alert>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Worker approvals</h1>
        <p className="text-muted text-sm">
          {queue.length === 0
            ? "Nothing waiting. New applications appear here the moment they're submitted."
            : `${queue.length} waiting, oldest first. The promise is ${APPROVAL_SLA_HOURS} hours.`}
        </p>
      </div>

      {queue.length === 0 ? null : (
        <ul className="border-border divide-border divide-y rounded-xl border">
          {queue.map((row) => {
            const overdue = row.slaDueAt !== null && new Date(row.slaDueAt) < new Date();

            return (
              <li key={row.applicationId}>
                <Link
                  href={ADMIN_ROUTES.application(row.applicationId)}
                  className="hover:bg-surface-muted flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3.5 transition-colors"
                >
                  <span className="min-w-0 space-y-0.5">
                    <span className="block text-sm font-medium">
                      {row.workerName}
                      {row.attempt > 1 ? (
                        <span className="text-muted font-normal"> · resubmission</span>
                      ) : null}
                    </span>
                    <span className="text-muted block text-xs">
                      {row.categoryNames.join(", ") || "No categories"} · {row.sampleCount}{" "}
                      {row.sampleCount === 1 ? "sample" : "samples"}
                      {row.submittedAt
                        ? ` · submitted ${formatDate(row.submittedAt)}, ${formatTime(row.submittedAt)}`
                        : ""}
                    </span>
                  </span>

                  {row.slaDueAt ? (
                    <span
                      className={cn(
                        "shrink-0 text-xs tabular-nums",
                        overdue ? "text-danger" : "text-muted",
                      )}
                    >
                      {formatCountdown(row.slaDueAt)}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
