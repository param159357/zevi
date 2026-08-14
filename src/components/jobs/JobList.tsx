import Link from "next/link";

import { EDITABLE_JOB_STATUSES, JOB_ROUTES } from "@/lib/constants/jobs";
import type { ClientJobSummary } from "@/lib/jobs/queries";
import type { JobStatus } from "@/lib/jobs/types";
import { formatDate } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

/** Plain words. A client should never have to learn our enum. */
const STATUS_LABELS: Record<JobStatus, string> = {
  draft: "Draft",
  pending_moderation: "With us for review",
  open: "Open for opt-ins",
  assigned: "In progress",
  delivered: "Waiting on your review",
  revision_requested: "Revision requested",
  disputed: "In dispute",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired",
  rejected: "Not accepted",
};

const STATUS_TONES: Partial<Record<JobStatus, string>> = {
  draft: "text-muted",
  delivered: "text-accent",
  disputed: "text-danger",
  completed: "text-success",
};

export function JobList({ jobs }: { jobs: ClientJobSummary[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-muted border-border rounded-xl border border-dashed px-4 py-8 text-center text-sm">
        Nothing posted yet.
      </p>
    );
  }

  return (
    <ul className="border-border divide-border divide-y rounded-xl border">
      {jobs.map((job) => {
        const editable = (EDITABLE_JOB_STATUSES as readonly string[]).includes(job.status);
        // The shortlist is worth a link once there is something on it: someone
        // to pick, or someone already picked (spec §5).
        const shortlist = job.optInCount > 0 || job.assignedWorkerId !== null;

        return (
          <li key={job.id} className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0 space-y-1">
              {editable ? (
                <Link
                  href={JOB_ROUTES.edit(job.id)}
                  className="hover:text-accent block truncate text-sm font-medium underline-offset-2 hover:underline"
                >
                  {job.title || "Untitled draft"}
                </Link>
              ) : (
                <p className="truncate text-sm font-medium">{job.title || "Untitled"}</p>
              )}

              <p className="text-muted text-xs">
                {[
                  job.postedAsOther ? "Uncategorised" : job.categoryName,
                  job.budgetPaise != null ? formatPaiseCompact(job.budgetPaise) : null,
                  job.deadlineAt ? `due ${formatDate(job.deadlineAt)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "Nothing filled in yet"}
              </p>

              {shortlist ? (
                <Link
                  href={JOB_ROUTES.shortlist(job.id)}
                  className="hover:text-accent text-accent block text-xs underline-offset-2 hover:underline"
                >
                  {job.assignedWorkerId !== null
                    ? "See who you picked"
                    : `${job.optInCount} interested — pick one`}
                </Link>
              ) : null}
            </div>

            <span
              className={cn(
                "shrink-0 text-xs",
                STATUS_TONES[job.status] ?? "text-foreground",
              )}
            >
              {STATUS_LABELS[job.status]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
