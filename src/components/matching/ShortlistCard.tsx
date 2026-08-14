import { PickWorker } from "@/components/matching/PickWorker";
import { isImageSample, isVideoSample } from "@/lib/constants/workers";
import type { ShortlistSample, ShortlistWorker, WorkerRating } from "@/lib/matching/types";
import { formatBytes, formatCount, formatDate, formatRating } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

/**
 * One opted-in worker, as spec §5 describes the shortlist: who they are, what
 * they have made, and the three things they wrote about this brief.
 *
 * A Server Component — the only interactive part is the pick itself, and that
 * is its own island further down. The previews are signed, short-lived URLs for
 * private objects, so they are deliberately not run through the Next image
 * optimiser: it would cache a URL that expires and re-serve a worker's private
 * sample from our own domain long after the signature died.
 */
export function ShortlistCard({
  worker,
  jobId,
  pickable,
}: {
  worker: ShortlistWorker;
  jobId: string;
  /** The job is still open and this opt-in is still live. */
  pickable: boolean;
}) {
  const selected = worker.status === "selected";
  const passedOver = worker.status === "not_selected";

  return (
    <li
      className={cn(
        "border-border space-y-4 rounded-xl border p-4 sm:p-5",
        selected && "border-success/40 bg-success/5",
        passedOver && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-semibold">{worker.displayName}</h3>
          <p className="text-muted text-xs">{describeWorkerRating(worker)}</p>
        </div>

        {selected ? (
          <span className="text-success shrink-0 text-xs font-medium">You picked them</span>
        ) : passedOver ? (
          <span className="text-muted shrink-0 text-xs">Not picked</span>
        ) : (
          <span className="text-muted shrink-0 text-xs">
            opted in {formatDate(worker.optedInAt)}
          </span>
        )}
      </div>

      {worker.headline ? <p className="text-sm">{worker.headline}</p> : null}

      {/* Spec §6's three short fields. The third is the one worth reading
          closely: a generic answer to "one thing you noticed in this brief" is
          the tell that nobody read it. */}
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <Field label="Software" value={worker.software} />
        <Field label="Turnaround" value={worker.turnaround} />
        <Field label="What they noticed" value={worker.noticed} />
      </dl>

      <Samples samples={worker.samples} />

      {pickable ? (
        <PickWorker jobId={jobId} optInId={worker.optInId} workerName={worker.displayName} />
      ) : null}
    </li>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-muted text-xs">{label}</dt>
      {/* Written by the worker and stored as typed: rendered as text, never
          treated as markup. */}
      <dd className="whitespace-pre-wrap">{value}</dd>
    </div>
  );
}

/**
 * The portfolio, in the job's own category. Three to six pieces by construction
 * (spec §6), so they lay out in a row that scrolls sideways rather than pushing
 * the next worker off the screen — a client is comparing people, and that
 * comparison only works if more than one of them fits in a viewport.
 */
function Samples({ samples }: { samples: ShortlistSample[] }) {
  if (samples.length === 0) {
    return (
      <p className="text-muted text-xs">
        No approved samples in this category — worth asking about before you pick.
      </p>
    );
  }

  return (
    <ul className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
      {samples.map((sample) => (
        <li key={sample.id} className="w-44 shrink-0 space-y-1.5">
          <div className="bg-surface-muted flex h-32 items-center justify-center overflow-hidden rounded-lg">
            {sample.previewUrl && isImageSample(sample.mimeType) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sample.previewUrl}
                alt={sample.caption}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            ) : sample.previewUrl && isVideoSample(sample.mimeType) ? (
              <video src={sample.previewUrl} controls preload="metadata" className="h-full w-full" />
            ) : (
              <p className="text-muted px-2 text-center text-xs">
                {sample.previewUrl ? "No preview for this format" : "Preview unavailable"}
              </p>
            )}
          </div>

          <p className="text-xs leading-snug">{sample.caption}</p>

          {sample.previewUrl ? (
            <a
              href={sample.previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted hover:text-foreground block truncate text-xs underline underline-offset-4"
            >
              Open · {formatBytes(sample.sizeBytes)}
            </a>
          ) : (
            <p className="text-muted truncate text-xs">{formatBytes(sample.sizeBytes)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Spec §6: the rating never appears without its job count, and it is
 * category-specific — "4.8 ★ (12 jobs) in Presentations" says something
 * different from the same number across everything they have ever done, so the
 * label says which one this is.
 */
export function describeWorkerRating(worker: {
  rating: WorkerRating;
  totalJobsCompleted: number;
}): string {
  const rating = formatRating(worker.rating.rating);

  if (rating === null) {
    return worker.totalJobsCompleted === 0
      ? "New here — no completed jobs yet"
      : `Not rated yet · ${formatCount(worker.totalJobsCompleted, "job")} completed`;
  }

  const scope = worker.rating.inCategory ? "in this category" : "across all their work";

  return [
    `${rating} (${formatCount(worker.rating.ratingCount, "rating")}) ${scope}`,
    `${formatCount(worker.totalJobsCompleted, "job")} completed`,
  ].join(" · ");
}
