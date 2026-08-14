import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { describeClient } from "@/components/matching/JobFeed";
import { OptInForm } from "@/components/matching/OptInForm";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadFeedBrief, loadMatchingSettings, loadOptInCapacity } from "@/lib/matching/queries";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDate, formatDateShort } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Job · Zevi" };

/**
 * One brief, and the opt-in (spec §6).
 *
 * `briefOpenedAt` is stamped here, on the server, and handed to the form —
 * that is where the 20-second dwell timer starts. See the note in
 * `lib/matching/actions.ts` for how far that timestamp is trusted and why.
 */
export default async function WorkerJobPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const { jobId } = await params;
  const brief = await loadFeedBrief(supabase, context.user.id, jobId);

  // RLS decided this, not the line below: a job outside the worker's categories
  // never came back at all. 404 is what that should look like.
  if (!brief) notFound();

  const settings = await loadMatchingSettings(supabase);
  const capacity = await loadOptInCapacity(supabase, context.user.id, settings.maxActiveOptIns);

  const panel = brief.optedIn ? (
    <Alert tone="success">
      You&apos;ve opted into this one.{" "}
      <Link href={WORKER_ROUTES.optIns} className="underline underline-offset-4">
        See your opt-ins
      </Link>
      .
    </Alert>
  ) : brief.status !== "open" ? (
    // Readable but closed: a job they opted into and withdrew from, or one that
    // was assigned while they were reading it.
    <Alert>This job isn&apos;t taking opt-ins any more.</Alert>
  ) : capacity.atCap ? (
    <Alert>
      You&apos;re holding {formatCount(capacity.used, "opt-in")}, which is the limit.{" "}
      <Link href={WORKER_ROUTES.optIns} className="underline underline-offset-4">
        Withdraw one
      </Link>{" "}
      to opt into this.
    </Alert>
  ) : (
    <OptInForm
      jobId={brief.id}
      // Stamped here, on the server: this is where the dwell timer starts.
      briefOpenedAt={new Date().toISOString()}
      dwellSeconds={settings.dwellSeconds}
    />
  );

  return (
    <div className="space-y-6">
      <Link
        href={WORKER_ROUTES.feed}
        className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
      >
        ← All jobs
      </Link>

      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">
            {brief.title}
          </h1>
          <p className="shrink-0 text-lg font-semibold tabular-nums">
            {formatPaiseCompact(brief.budgetPaise)}
          </p>
        </div>

        <p className="text-muted text-sm">
          {[
            brief.categoryName,
            brief.deadlineAt ? `due ${formatDateShort(brief.deadlineAt)}` : null,
            brief.publishedAt ? `posted ${formatDate(brief.publishedAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        <p className="text-muted text-sm">{describeClient(brief.client)}</p>
      </div>

      <div className="border-border rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-medium">The brief</h2>
        {/* Stored as typed. `whitespace-pre-wrap` keeps the client's paragraphs
            without ever treating their text as markup. */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{brief.description}</p>
      </div>

      <p className="text-muted text-xs">
        {brief.optInCount === 0
          ? "No one has opted in yet."
          : `${formatCount(brief.optInCount, "worker")} already opted in.`}
      </p>

      {panel}
    </div>
  );
}
