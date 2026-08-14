import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewDecisionForm } from "@/components/admin/ReviewDecisionForm";
import { Alert } from "@/components/ui/Alert";
import { loadApplicationForReview } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import type { ReviewCategory, ReviewSample } from "@/lib/admin/types";
import { ADMIN_ROUTES, isImageSample, isVideoSample } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatBytes, formatCountdown, formatDate, formatTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Review samples · Zevi" };

/**
 * One application, the way spec §7 describes the module: samples, captions and
 * a reverse-image-search link, with approve / reject / flag underneath.
 *
 * Previews are signed for ten minutes with the service-role key — the storage
 * policy is anchored on the object's owner and a reviewer is not the owner
 * (see `lib/admin/queries`). They are deliberately not run through the Next
 * image optimiser: it would cache a URL that expires, and re-serve a private
 * sample from our own domain long after the signature died.
 */
export default async function ApplicationReviewPage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  await requireAdmin("review_workers");

  const { applicationId } = await params;
  const supabase = await createClient();

  const review = await loadApplicationForReview(supabase, applicationId);
  if (!review) notFound();

  const overdue = review.slaDueAt !== null && new Date(review.slaDueAt) < new Date();
  const decided = review.status !== "submitted";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link
          href={ADMIN_ROUTES.approvals}
          className="text-muted hover:text-foreground text-xs underline underline-offset-4"
        >
          ← Worker approvals
        </Link>

        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{review.workerName}</h1>

          {review.slaDueAt && !decided ? (
            <span
              className={cn("text-xs tabular-nums", overdue ? "text-danger" : "text-muted")}
            >
              {formatCountdown(review.slaDueAt)}
            </span>
          ) : null}
        </div>

        <p className="text-muted text-sm">
          {review.workerEmail} · member since {formatDate(review.memberSince)}
          {review.attempt > 1 ? ` · attempt ${review.attempt}` : ""}
          {review.submittedAt
            ? ` · submitted ${formatDate(review.submittedAt)}, ${formatTime(review.submittedAt)}`
            : ""}
        </p>

        <p className="text-muted text-xs">
          The name above is the one they signed up with. Spec §6 has it match the ID and
          the bank account, so a sample credited to a different name is worth asking about.
        </p>
      </div>

      {decided ? (
        <Alert tone="info">
          Already decided{review.reviewedAt ? ` on ${formatDate(review.reviewedAt)}` : ""} —{" "}
          {review.status.replace(/_/g, " ")}
          {review.decisionReason ? `: ${review.decisionReason}` : "."}
        </Alert>
      ) : null}

      {review.categories.map((category) => (
        <CategoryReview key={category.id} category={category} />
      ))}

      {decided ? null : <ReviewDecisionForm applicationId={review.applicationId} />}
    </div>
  );
}

function CategoryReview({ category }: { category: ReviewCategory }) {
  const short = category.samples.length < category.sampleMin;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold">{category.name}</h2>
        <p className={cn("text-xs tabular-nums", short ? "text-danger" : "text-muted")}>
          {category.samples.length} of {category.sampleMax} · {category.sampleMin} minimum
        </p>
      </div>

      {category.formatNote ? (
        <p className="text-muted text-xs">Expected: {category.formatNote}</p>
      ) : null}

      {category.samples.length === 0 ? (
        <p className="text-muted text-sm">No samples in this category.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {category.samples.map((sample) => (
            <SampleCard key={sample.id} sample={sample} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SampleCard({ sample }: { sample: ReviewSample }) {
  return (
    <li className="border-border space-y-2 overflow-hidden rounded-xl border p-3">
      <div className="bg-surface-muted flex min-h-40 items-center justify-center overflow-hidden rounded-lg">
        {sample.previewUrl && isImageSample(sample.mimeType) ? (
          // A signed, short-lived URL for a private object: the optimiser would
          // cache it past its expiry and re-serve a worker's sample from our own
          // domain, so this one stays a plain img.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={sample.previewUrl}
            alt={sample.caption}
            className="max-h-72 w-full object-contain"
          />
        ) : sample.previewUrl && isVideoSample(sample.mimeType) ? (
          <video src={sample.previewUrl} controls preload="metadata" className="max-h-72 w-full" />
        ) : (
          <p className="text-muted px-3 py-8 text-center text-xs">
            {sample.previewUrl ? "No preview for this format." : "Preview unavailable."}
          </p>
        )}
      </div>

      <p className="text-sm">{sample.caption}</p>

      <p className="text-muted truncate text-xs">
        {sample.name} · {formatBytes(sample.sizeBytes)}
      </p>

      <div className="flex flex-wrap gap-3 text-xs">
        {sample.previewUrl ? (
          <a
            href={sample.previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Open
          </a>
        ) : null}

        {sample.reverseSearchUrl ? (
          <a
            href={sample.reverseSearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted hover:text-foreground underline underline-offset-4"
          >
            Reverse image search
          </a>
        ) : null}
      </div>
    </li>
  );
}
