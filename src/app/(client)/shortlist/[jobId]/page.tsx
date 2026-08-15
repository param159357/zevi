import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CancelJobForm } from "@/components/jobs/CancelJobForm";
import { FeeBreakdown } from "@/components/jobs/FeeBreakdown";
import { ShortlistCard } from "@/components/matching/ShortlistCard";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { loadCancellationPreview } from "@/lib/cancellations/queries";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { isRazorpayConfigured } from "@/lib/env";
import { SHORTLIST_PAGE_SIZE, SHORTLIST_PICKED_PARAM } from "@/lib/constants/matching";
import { PICKABLE_OPT_IN_STATUSES, loadShortlist } from "@/lib/matching/shortlist";
import type { Shortlist } from "@/lib/matching/types";
import { priceJob } from "@/lib/money/commission";
import { loadRates } from "@/lib/money/rates";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDateShort } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Who's interested · Zevi" };

/**
 * The shortlist (spec §5): every worker who opted in, best-rated first, each
 * with their samples and the three things they wrote about this brief.
 *
 * Spec §5's five slots — one top-rated, three AI-ranked, one newest — are not
 * here, because spec §16 cuts the ranking from V1 and replaces the whole screen
 * with one line: "show all opted-in workers sorted by rating". No slots, no cap,
 * nothing written to `job_shortlists`. See `lib/matching/shortlist.ts`.
 */
export default async function ShortlistPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ [SHORTLIST_PICKED_PARAM]?: string }>;
}) {
  const context = await requireRole("client");
  const supabase = await createClient();

  const [{ jobId }, query] = await Promise.all([params, searchParams]);

  const [shortlist, cancellation] = await Promise.all([
    loadShortlist(supabase, jobId, context.user.id),
    loadCancellationPreview(supabase, jobId, context.user.id),
  ]);

  // Someone else's job never came back from the query at all — RLS decided
  // that, not the line above. A 404 is what that should look like.
  if (!shortlist) notFound();

  const open = shortlist.status === "open";
  const justPicked = shortlist.workers.find(
    (worker) => worker.workerId === query[SHORTLIST_PICKED_PARAM] && worker.status === "selected",
  );

  // Priced once for the whole screen: the breakdown above the list and the
  // figure on every card's confirm step are the same calculation, and the
  // charge itself re-runs it server-side before an order is created.
  const { slabs, taxRateBps } = await loadRates(supabase);
  const price = priceJob({ budgetPaise: shortlist.budgetPaise, slabs, taxRateBps });

  // Payment is not optional — spec §4 charges at selection — so a deployment
  // without gateway keys says so rather than quietly assigning jobs for free.
  const canPay = isRazorpayConfigured();

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
            {shortlist.title}
          </h1>
          <p className="shrink-0 text-lg font-semibold tabular-nums">
            {formatPaiseCompact(shortlist.budgetPaise)}
          </p>
        </div>

        <p className="text-muted text-sm">
          {[
            shortlist.postedAsOther && !shortlist.categoryName
              ? "Uncategorised"
              : shortlist.categoryName,
            shortlist.deadlineAt ? `due ${formatDateShort(shortlist.deadlineAt)}` : null,
            open ? `${formatCount(shortlist.workers.length, "worker")} opted in` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {justPicked ? (
        <Alert tone="success">
          {justPicked.displayName} has the job. They can see the brief and its attachments
          now, and everyone else has been told they weren&apos;t picked.
        </Alert>
      ) : null}

      <StatusNotice shortlist={shortlist} />

      {open && shortlist.workers.length > 0 && !canPay ? (
        <Alert tone="error">
          Card payments aren&apos;t switched on for this deployment, so nobody can be
          picked yet. Set the Razorpay keys from <code>.env.example</code> and reload.
        </Alert>
      ) : null}

      {open && shortlist.workers.length > 0 && price ? (
        <FeeBreakdown
          price={price}
          note={
            // Spec §4: "client picks one, payment happens here, into escrow."
            <>
              You&apos;re charged when you pick someone, and the money is held until you
              accept their work.
            </>
          }
        />
      ) : null}

      {shortlist.workers.length > 0 ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-medium">
              {open ? "Sorted by rating, best first" : "Who opted in"}
            </h2>
            {shortlist.truncated ? (
              <p className="text-muted text-xs">
                Showing the first {SHORTLIST_PAGE_SIZE}.
              </p>
            ) : null}
          </div>

          <ul className="space-y-4">
            {shortlist.workers.map((worker) => (
              <ShortlistCard
                key={worker.optInId}
                worker={worker}
                jobId={shortlist.jobId}
                pickable={
                  open && canPay && PICKABLE_OPT_IN_STATUSES.includes(worker.status)
                }
                clientTotalPaise={price?.clientTotalPaise ?? null}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Spec §5's first row — "no worker assigned yet: full, instant, no fee" —
          needs a door, and this is the screen an unassigned job lives on. Once
          someone is picked the job moves to `/review/[jobId]` and the cancel
          panel goes with it, because from then on the tiers depend on the clock
          and that screen is where the clock is. */}
      {cancellation?.offered && shortlist.assignedWorkerId === null ? (
        <section className="border-border space-y-3 border-t pt-6">
          <h2 className="text-sm font-medium">Changed your mind?</h2>
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

/** Why the list is empty, or why it can no longer be acted on. */
function StatusNotice({ shortlist }: { shortlist: Shortlist }) {
  if (shortlist.status === "draft") {
    return (
      <Alert>
        This one is still a draft, so no one can see it.{" "}
        <Link
          href={JOB_ROUTES.edit(shortlist.jobId)}
          className="underline underline-offset-4"
        >
          Finish and post it
        </Link>
        .
      </Alert>
    );
  }

  if (shortlist.status === "pending_moderation") {
    return <Alert>We&apos;re checking this one over. Workers see it as soon as we&apos;re done.</Alert>;
  }

  if (shortlist.status === "open" && shortlist.categoryId === null) {
    // Posted as "Other". `approved workers opt into open jobs` requires a
    // category, so this job genuinely cannot be opted into until one is filed.
    return (
      <Alert>
        We&apos;re still filing this under a category. Workers start seeing it — and
        opting in — as soon as that&apos;s done.
      </Alert>
    );
  }

  if (shortlist.status === "open" && shortlist.workers.length === 0) {
    return (
      <Alert>
        No one has opted in yet. Workers in this category see it in their feed, and
        they&apos;ll appear here as they do.
      </Alert>
    );
  }

  if (shortlist.status !== "open" && shortlist.assignedWorkerId === null) {
    return <Alert>This job isn&apos;t taking opt-ins any more.</Alert>;
  }

  return null;
}
