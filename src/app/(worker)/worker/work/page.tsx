import type { Metadata } from "next";
import Link from "next/link";

import { requireRole } from "@/lib/auth/session";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadWorkerJobs } from "@/lib/deliveries/queries";
import type { JobStatus } from "@/lib/jobs/types";
import { createClient } from "@/lib/supabase/server";
import { formatDateShort, formatRemaining } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Your work · Zevi" };

/**
 * Jobs this worker was picked for — spec §6's "Delivery", the screen between
 * being selected and being paid.
 *
 * Separate from `/worker/jobs`, which is the feed: one is what they could take
 * and the other is what they have. A worker with a deadline tomorrow should not
 * have to find it inside a list of things they might opt into.
 */

/** Plain words. A worker should never have to learn our enum either. */
const STATUS_LABELS: Partial<Record<JobStatus, string>> = {
  assigned: "Yours to deliver",
  delivered: "With the client",
  revision_requested: "Revision asked for",
  completed: "Done",
  disputed: "In dispute",
  cancelled: "Cancelled",
};

const STATUS_TONES: Partial<Record<JobStatus, string>> = {
  assigned: "text-accent",
  revision_requested: "text-danger",
  completed: "text-success",
  disputed: "text-danger",
};

export default async function WorkerWorkPage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const jobs = await loadWorkerJobs(supabase, context.user.id);
  const live = jobs.filter((job) => job.status !== "completed" && job.status !== "cancelled");

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your work</h1>
        <p className="text-muted text-sm">
          {jobs.length === 0
            ? "Nothing yet. Jobs land here when a client picks you."
            : live.length === 0
              ? "Nothing outstanding — everything here is finished."
              : `${live.length} on the go.`}
        </p>
      </div>

      {jobs.length === 0 ? (
        <div className="border-border space-y-3 rounded-xl border border-dashed px-4 py-8 text-center">
          <p className="text-muted text-sm">
            A client has to pick you before a job shows up here.
          </p>
          <Link
            href={WORKER_ROUTES.feed}
            className="text-foreground inline-block text-sm underline underline-offset-4"
          >
            Browse open jobs
          </Link>
        </div>
      ) : (
        <ul className="border-border divide-border divide-y rounded-xl border">
          {jobs.map((job) => (
            <li key={job.jobId} className="flex items-start justify-between gap-4 px-4 py-3.5">
              <div className="min-w-0 space-y-1">
                <Link
                  href={WORKER_ROUTES.deliver(job.jobId)}
                  className="hover:text-accent block truncate text-sm font-medium underline-offset-2 hover:underline"
                >
                  {job.title}
                </Link>

                <p className="text-muted text-xs">
                  {[
                    job.categoryName,
                    formatPaiseCompact(job.budgetPaise),
                    job.deadlineAt ? `due ${formatDateShort(job.deadlineAt)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>

                {/* The auto-accept clock is the worker's news too: it is when
                    they get paid if the client says nothing. */}
                {job.autoAcceptAt ? (
                  <p className="text-muted text-xs">
                    Accepted automatically in {formatRemaining(job.autoAcceptAt)}
                  </p>
                ) : null}
              </div>

              <span
                className={cn(
                  "shrink-0 text-xs",
                  STATUS_TONES[job.status] ?? "text-foreground",
                )}
              >
                {STATUS_LABELS[job.status] ?? "In progress"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
