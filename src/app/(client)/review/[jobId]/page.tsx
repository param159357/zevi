import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeliveryAttemptPanel } from "@/components/deliveries/DeliveryAttemptPanel";
import { ReviewActions } from "@/components/deliveries/ReviewActions";
import { CancelJobForm } from "@/components/jobs/CancelJobForm";
import { RefundPanel } from "@/components/jobs/RefundPanel";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { loadCancellationPreview } from "@/lib/cancellations/queries";
import { RETENTION_DAYS_ACCEPTED, autoAcceptWindowLabel } from "@/lib/constants/deliveries";
import { DISPUTE_ROUTES } from "@/lib/constants/disputes";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { loadDeliveryReview } from "@/lib/deliveries/queries";
import type { DeliveryReview } from "@/lib/deliveries/types";
import { liveDisputeForJob } from "@/lib/disputes/queries";
import { loadJobRefunds } from "@/lib/refunds/queries";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateShort, formatRemaining } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Review the work · Zevi" };

/**
 * Spec §5, "Reviewing delivery": accept, ask for the one free revision, open a
 * case, or let the clock decide.
 *
 * All three endings the spec lists are here now. The fourth thing this screen
 * carries is cancellation (spec §5's other table), which is a different question
 * — it applies *before* anything is delivered, and the moment a worker has sent
 * something the tiers stop and the three endings above are the only doors. That
 * is why the cancel panel is rendered from its own quote rather than from the
 * job's status: `quoteCancellation()` is what knows which of those two worlds
 * this job is in.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const context = await requireRole("client");
  const supabase = await createClient();

  const { jobId } = await params;

  const [review, cancellation, dispute, refunds] = await Promise.all([
    loadDeliveryReview(supabase, jobId, context.user.id),
    loadCancellationPreview(supabase, jobId, context.user.id),
    liveDisputeForJob(supabase, jobId),
    loadJobRefunds(supabase, jobId),
  ]);

  // Someone else's job never came back from the query at all — RLS decided
  // that. A 404 is what that should look like.
  if (!review) notFound();

  const open = review.deliveries.find((delivery) => delivery.id === review.openDeliveryId);
  const rest = review.deliveries.filter((delivery) => delivery.id !== review.openDeliveryId);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href={JOB_ROUTES.dashboard}
          className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
        >
          ← Your jobs
        </Link>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
            {review.title}
          </h1>
          <p className="shrink-0 text-lg font-semibold tabular-nums">
            {formatPaiseCompact(review.budgetPaise)}
          </p>
        </div>

        <p className="text-muted text-sm">
          {[
            review.categoryName,
            `${review.workerName} is on it`,
            review.deadlineAt ? `due ${formatDateShort(review.deadlineAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <StatusNotice review={review} />

      {dispute ? (
        <Alert tone="error">
          There is an open case on this job and the money is frozen until it is decided.{" "}
          <Link href={DISPUTE_ROUTES.case(dispute.disputeId)} className="underline">
            See where it has got to
          </Link>
          .
        </Alert>
      ) : null}

      {/* Above the delivery, not below it. On a cancelled or refunded job this
          is the only thing the client came here to find out. */}
      <RefundPanel refunds={refunds} />

      {open ? (
        <section className="space-y-4">
          <DeliveryAttemptPanel delivery={open} viewer="client" />

          <ReviewActions
            deliveryId={open.id}
            jobId={review.jobId}
            workerName={review.workerName}
            freeRevisionsLeft={review.freeRevisionsLeft}
          />
        </section>
      ) : null}

      {review.revisions.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">What you asked for</h2>
          <ul className="border-border divide-border divide-y rounded-xl border">
            {review.revisions.map((revision) => (
              <li key={revision.id} className="space-y-1 px-4 py-3">
                <p className="text-muted text-xs">
                  {revision.isFree ? "Free revision" : `Revision ${revision.sequence}`} ·{" "}
                  {formatDate(revision.createdAt)}
                  {revision.status === "delivered" ? " · answered" : ""}
                </p>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{revision.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {rest.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">
            {open ? "Earlier attempts" : "What was delivered"}
          </h2>
          {rest.map((delivery) => (
            <DeliveryAttemptPanel
              key={delivery.id}
              delivery={delivery}
              viewer="client"
              dimmed={delivery.status === "superseded"}
            />
          ))}
        </section>
      ) : null}

      {/* Spec §5's cancellation table. Last on the page on purpose: it is the
          thing to do when none of the above is what you wanted, and a client
          scanning for "accept" should not meet it first. */}
      {cancellation?.offered ? (
        <section className="border-border space-y-3 border-t pt-6">
          <h2 className="text-sm font-medium">Cancel this job</h2>
          <CancelJobForm
            jobId={cancellation.jobId}
            quote={cancellation.quote}
            workerName={cancellation.workerName}
          />
        </section>
      ) : null}
    </div>
  );
}

/** Where the job is, and what the client is being asked to do about it. */
function StatusNotice({ review }: { review: DeliveryReview }) {
  const open = review.deliveries.find((delivery) => delivery.id === review.openDeliveryId);

  if (open) {
    return (
      <Alert tone="success">
        {review.workerName} delivered on {formatDate(open.deliveredAt)}. You have until{" "}
        {formatDate(open.autoAcceptAt)} — {formatRemaining(open.autoAcceptAt)} — to accept
        or ask for a revision. After that it&apos;s accepted automatically and the money
        goes to them.
      </Alert>
    );
  }

  if (review.status === "completed") {
    const accepted = review.deliveries.find((delivery) => delivery.status === "accepted");

    return (
      <Alert tone="success">
        {accepted?.autoAccepted
          ? `This was accepted automatically — the ${autoAcceptWindowLabel(review.budgetPaise)} ran out.`
          : "You accepted this work."}{" "}
        The files are yours to download for {RETENTION_DAYS_ACCEPTED} days — take your
        copy now.
      </Alert>
    );
  }

  if (review.status === "revision_requested") {
    return (
      <Alert>
        {review.workerName} is working on your revision. You&apos;ll get a fresh review
        window when they send it.
      </Alert>
    );
  }

  if (review.status === "assigned") {
    return (
      <Alert>
        {review.workerName} is working on this. Nothing to do until they deliver.
      </Alert>
    );
  }

  if (review.status === "disputed") {
    // The banner above this carries the link and the detail; this only says
    // where the job itself has got to.
    return (
      <Alert tone="error">
        This job is on hold while the case is decided. Nothing more is expected from you
        until then.
      </Alert>
    );
  }

  if (review.status === "cancelled") {
    // Deliberately says nothing about the money any more. It used to promise a
    // refund in the abstract because nothing was actually issuing one; the panel
    // below now shows the real row, with the amount and where it has got to, and
    // two statements about the same refund is how they come to disagree.
    return <Alert>This job was cancelled.</Alert>;
  }

  return <Alert>Nothing has been delivered on this job yet.</Alert>;
}
