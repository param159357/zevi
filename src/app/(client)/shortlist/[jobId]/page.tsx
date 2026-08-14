import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FeeBreakdown } from "@/components/jobs/FeeBreakdown";
import { ShortlistCard } from "@/components/matching/ShortlistCard";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { JOB_ROUTES } from "@/lib/constants/jobs";
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
  const shortlist = await loadShortlist(supabase, jobId, context.user.id);

  // Someone else's job never came back from the query at all — RLS decided
  // that, not the line above. A 404 is what that should look like.
  if (!shortlist) notFound();

  const open = shortlist.status === "open";
  const justPicked = shortlist.workers.find(
    (worker) => worker.workerId === query[SHORTLIST_PICKED_PARAM] && worker.status === "selected",
  );

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

      {open && shortlist.workers.length > 0 ? (
        <Price budgetPaise={shortlist.budgetPaise} />
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
                pickable={open && PICKABLE_OPT_IN_STATUSES.includes(worker.status)}
              />
            ))}
          </ul>
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

/**
 * What picking someone costs — spec §5: "fee shown as a separate line, never
 * hidden". Recomputed here from the job's own budget and the rates in effect,
 * never from anything the page was handed.
 */
async function Price({ budgetPaise }: { budgetPaise: number }) {
  const supabase = await createClient();
  const { slabs, taxRateBps } = await loadRates(supabase);
  const price = priceJob({ budgetPaise, slabs, taxRateBps });

  // `slabFor` returning null means a hole in `commission_slabs`, which is a
  // broken deployment rather than a pricing edge case — but it is not a reason
  // to refuse a client the shortlist they came for.
  if (!price) return null;

  return (
    <FeeBreakdown
      price={price}
      note={
        // Spec §4 puts the charge exactly here — "client picks one, payment
        // happens here, into escrow" — and the gateway is not wired up yet. The
        // screen says what actually happens rather than quoting a total nobody
        // is collecting. See `selectWorker` in lib/matching/actions.ts.
        <>
          Card payment isn&apos;t switched on yet, so nothing is charged when you pick.
          This is what the job will cost once it is.
        </>
      }
    />
  );
}
