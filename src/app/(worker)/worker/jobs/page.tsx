import type { Metadata } from "next";
import Link from "next/link";

import { CategoryFilter } from "@/components/matching/CategoryFilter";
import { JobFeed } from "@/components/matching/JobFeed";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { FEED_CATEGORY_PARAM, FEED_PAGE_SIZE } from "@/lib/constants/matching";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadWorkerFeed } from "@/lib/matching/queries";
import { createClient } from "@/lib/supabase/server";
import { formatCount } from "@/lib/utils/format";

export const metadata: Metadata = { title: "Jobs · Zevi" };

/**
 * The job feed (spec §6): open jobs in the worker's own categories, newest
 * first. RLS is what filters it — `approved workers read the open feed` in
 * migration 0006 — so an unapproved worker gets nothing here and is told why
 * rather than being shown an empty board.
 */
export default async function WorkerFeedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const params = await searchParams;
  const requested = params[FEED_CATEGORY_PARAM];
  const feed = await loadWorkerFeed(
    supabase,
    context.user.id,
    typeof requested === "string" ? requested : null,
  );

  const approved =
    feed.workerStatus === "approved" || feed.workerStatus === "approved_with_flag";

  if (!approved) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
        <Alert>
          Your feed opens once your samples are approved. Jobs in your categories show up
          here the moment they&apos;re posted.
        </Alert>
        <Link
          href={WORKER_ROUTES.home}
          className="text-foreground inline-block text-sm underline underline-offset-4"
        >
          See what&apos;s left to do
        </Link>
      </div>
    );
  }

  const total = feed.categories.reduce((sum, category) => sum + category.jobCount, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-muted text-sm">
            Open jobs in your categories, newest first.
          </p>
        </div>

        <Link
          href={WORKER_ROUTES.optIns}
          className="border-border hover:bg-surface-muted shrink-0 rounded-lg border px-3 py-2 text-xs transition-colors"
        >
          {feed.capacity.used} of {feed.capacity.cap} opt-ins used
        </Link>
      </div>

      {feed.capacity.atCap ? (
        <Alert>
          You&apos;re holding {formatCount(feed.capacity.used, "opt-in")}, which is the
          limit.{" "}
          <Link href={WORKER_ROUTES.optIns} className="underline underline-offset-4">
            Withdraw one
          </Link>{" "}
          to free a slot.
        </Alert>
      ) : null}

      <CategoryFilter
        categories={feed.categories}
        activeCategoryId={feed.activeCategoryId}
        total={total}
      />

      <JobFeed jobs={feed.jobs} />

      {feed.truncated ? (
        <p className="text-muted text-xs">
          Showing the {FEED_PAGE_SIZE} newest. Filter by category to see further back.
        </p>
      ) : null}
    </div>
  );
}
