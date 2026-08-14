import Link from "next/link";

import { WORKER_ROUTES } from "@/lib/constants/workers";
import type { FeedClient, FeedJob } from "@/lib/matching/types";
import { formatCount, formatDateShort, formatRating } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

/**
 * Spec §6's card: title, budget, deadline, client rating, jobs completed, and
 * how many have already opted in. A Server Component — no state, no motion, and
 * nothing here that a worker scrolling past forty of these should have to wait
 * for JavaScript to see.
 */
export function JobFeed({ jobs }: { jobs: FeedJob[] }) {
  if (jobs.length === 0) {
    return (
      <p className="text-muted border-border rounded-xl border border-dashed px-4 py-8 text-center text-sm">
        Nothing open in your categories right now. New jobs land here as they&apos;re posted.
      </p>
    );
  }

  return (
    <ul className="border-border divide-border divide-y rounded-xl border">
      {jobs.map((job) => (
        <li key={job.id}>
          <Link
            href={WORKER_ROUTES.job(job.id)}
            className="hover:bg-surface-muted focus-visible:ring-accent block px-4 py-3.5 transition-colors focus-visible:ring-2 focus-visible:-outline-offset-2"
          >
            <div className="flex items-start justify-between gap-4">
              <p className="min-w-0 flex-1 text-sm font-medium">{job.title}</p>
              <p className="shrink-0 text-sm font-medium tabular-nums">
                {formatPaiseCompact(job.budgetPaise)}
              </p>
            </div>

            <p className="text-muted mt-1 text-xs">
              {[
                job.categoryName,
                job.deadlineAt ? `due ${formatDateShort(job.deadlineAt)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>

            <p className="text-muted mt-1.5 text-xs">
              {describeClient(job.client)}
            </p>

            <p className="mt-1.5 text-xs">
              {job.optedIn ? (
                <span className="text-success">You&apos;ve opted in</span>
              ) : (
                <span className="text-muted">
                  {job.optInCount === 0
                    ? "No one has opted in yet"
                    : `${formatCount(job.optInCount, "worker")} already opted in`}
                </span>
              )}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A client with no rating is a client nobody has finished a job for yet — worth
 * saying plainly rather than rendering an empty star. Spec §6 never shows a
 * rating without the job count beside it.
 */
export function describeClient(client: FeedClient): string {
  const rating = formatRating(client.rating);

  return [
    client.displayName,
    rating ?? "not rated yet",
    `${formatCount(client.jobsCompleted, "job")} completed`,
  ].join(" · ");
}
