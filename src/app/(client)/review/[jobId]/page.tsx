import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeliveryAttemptPanel } from "@/components/deliveries/DeliveryAttemptPanel";
import { ReviewActions } from "@/components/deliveries/ReviewActions";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { RETENTION_DAYS_ACCEPTED, autoAcceptWindowLabel } from "@/lib/constants/deliveries";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { loadDeliveryReview } from "@/lib/deliveries/queries";
import type { DeliveryReview } from "@/lib/deliveries/types";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateShort, formatRemaining } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Review the work · Zevi" };

/**
 * Spec §5, "Reviewing delivery": accept, ask for the one free revision, or let
 * the clock decide.
 *
 * Dispute is the third ending the spec lists and it is not here, because the
 * four-layer resolution flow (§11) is explicitly out of V1 (§16). A button that
 * opened nothing would be worse than the sentence under the actions pointing at
 * support.
 */
export default async function ReviewPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const context = await requireRole("client");
  const supabase = await createClient();

  const { jobId } = await params;
  const review = await loadDeliveryReview(supabase, jobId, context.user.id);

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

      {open ? (
        <section className="space-y-4">
          <DeliveryAttemptPanel delivery={open} viewer="client" />

          <ReviewActions
            deliveryId={open.id}
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
    return <Alert tone="error">This job is in dispute. We&apos;ll be in touch.</Alert>;
  }

  if (review.status === "cancelled") {
    return <Alert>This job was cancelled.</Alert>;
  }

  return <Alert>Nothing has been delivered on this job yet.</Alert>;
}
