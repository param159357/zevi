import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { JobPostForm } from "@/components/jobs/JobPostForm";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { EDITABLE_JOB_STATUSES, JOB_ROUTES } from "@/lib/constants/jobs";
import { loadJobForEditing, loadPostableCategories } from "@/lib/jobs/queries";
import { loadRates } from "@/lib/money/rates";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Edit job · Zevi" };

/**
 * Resuming a draft, or editing a job that is already live — spec §5 keeps a job
 * editable until a worker is assigned. After that the trigger in migration 0006
 * takes over: the brief and the price freeze, and only the deadline may move,
 * outward.
 */
export default async function EditJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const { jobId } = await params;
  const context = await requireRole("client");
  const supabase = await createClient();

  const loaded = await loadJobForEditing(supabase, jobId, context.user.id);
  if (!loaded) notFound();

  if (!(EDITABLE_JOB_STATUSES as readonly string[]).includes(loaded.job.status)) {
    redirect(JOB_ROUTES.dashboard);
  }

  const [categories, rates] = await Promise.all([
    loadPostableCategories(supabase),
    loadRates(supabase),
  ]);

  const isLive = loaded.job.status !== "draft";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {isLive ? "Edit this job" : "Finish this draft"}
        </h1>
        <p className="text-muted text-sm">
          {isLive
            ? "Changes reach every worker who hasn't opted in yet. Once you pick someone, the brief and the budget are fixed."
            : "Nobody can see this until you post it."}
        </p>
      </div>

      {loaded.job.status === "pending_moderation" ? (
        <Alert tone="info">
          We&apos;re looking this one over before it goes out to workers. You can
          still change it while we do.
        </Alert>
      ) : null}

      <JobPostForm
        ownerId={context.user.id}
        categories={categories}
        slabs={rates.slabs}
        taxRateBps={rates.taxRateBps}
        job={loaded.job}
        attachments={loaded.attachments}
      />
    </div>
  );
}
