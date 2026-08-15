import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { RaiseDisputeForm } from "@/components/disputes/RaiseDisputeForm";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { DISPUTE_ROUTES } from "@/lib/constants/disputes";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { disputeEligibility } from "@/lib/disputes/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Open a case · Zevi" };

/**
 * Spec §11's "both sides can raise a dispute", as one screen for both of them.
 *
 * The windows differ by side — a client may raise one from delivery until 48
 * hours after acceptance, a worker from assignment until they are paid — so what
 * this page mostly does is say which side the reader is on and whether their
 * window is open. `open_dispute()` checks the same two things again under the
 * job's row lock; this is here so nobody types 500 characters into a form that
 * was always going to refuse them.
 */
export default async function RaiseDisputePage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const context = await requireUser();
  const supabase = await createClient();

  const { jobId } = await params;
  const detail = await disputeEligibility(supabase, jobId, context.user.id);

  // Not a party to this job, or no such job. RLS returned nothing either way.
  if (!detail) notFound();

  // A case already exists, so this is not a second one — it is the one they are
  // looking for.
  if (detail.existingDisputeId) {
    redirect(DISPUTE_ROUTES.case(detail.existingDisputeId));
  }

  const backHref =
    detail.viewerRole === "client"
      ? JOB_ROUTES.review(detail.jobId)
      : WORKER_ROUTES.deliver(detail.jobId);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href={backHref}
          className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
        >
          ← {detail.jobTitle}
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">Open a case</h1>

        <p className="text-muted text-sm">
          {detail.jobTitle} · with {detail.otherPartyName}
        </p>
      </div>

      {detail.eligibility.canRaise ? (
        <>
          {detail.eligibility.deadlineNote ? (
            <Alert>{detail.eligibility.deadlineNote}</Alert>
          ) : null}

          {detail.viewerRole === "client" ? (
            <Alert>
              If the work is close but not right, asking for the free revision is faster
              than this and usually gets you what you wanted.
            </Alert>
          ) : null}

          <RaiseDisputeForm
            jobId={detail.jobId}
            viewerRole={detail.viewerRole}
            otherPartyName={detail.otherPartyName}
          />
        </>
      ) : (
        <>
          <Alert tone="error">{detail.eligibility.reason}</Alert>
          <Link
            href={backHref}
            className="text-accent inline-block text-sm underline-offset-4 hover:underline"
          >
            Back to the job
          </Link>
        </>
      )}
    </div>
  );
}
