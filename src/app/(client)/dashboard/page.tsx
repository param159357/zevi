import type { Metadata } from "next";
import Link from "next/link";

import { JobList } from "@/components/jobs/JobList";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { requireRole } from "@/lib/auth/session";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { loadClientJobs } from "@/lib/jobs/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard · Zevi" };

/**
 * Spec §5 puts active jobs, work awaiting review, past jobs, payments and
 * receipts here. Posting exists now, so the job list is real; payments and
 * receipts arrive with the money work.
 */
export default async function ClientDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ posted?: string }>;
}) {
  const context = await requireRole("client");
  const supabase = await createClient();

  const [{ posted }, jobs] = await Promise.all([
    searchParams,
    loadClientJobs(supabase, context.user.id),
  ]);

  const justPosted = posted ? jobs.find((job) => job.id === posted) : undefined;
  const drafts = jobs.filter((job) => job.status === "draft");

  return (
    <div className="space-y-8">
      {justPosted ? (
        <Alert tone="success">
          {justPosted.status === "pending_moderation"
            ? "Posted. We're checking this one over first — you'll hear from us shortly, and workers see it as soon as we're done."
            : "Posted. Workers in this category can see it now, and we'll tell you as soon as someone opts in."}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {context.profile.display_name ?? context.profile.full_name}
          </h1>
          <p className="text-muted text-sm">
            {jobs.length === 0
              ? "Post your first job — it's free, and you only pay once you've picked someone."
              : `${jobs.length} ${jobs.length === 1 ? "job" : "jobs"}${drafts.length > 0 ? `, ${drafts.length} still in draft` : ""}.`}
          </p>
        </div>

        <Link href={JOB_ROUTES.post}>
          <Button fullWidth={false}>Post a job</Button>
        </Link>
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Your jobs</h2>
        <JobList jobs={jobs} />
      </section>
    </div>
  );
}
