import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeliveryAttemptPanel } from "@/components/deliveries/DeliveryAttemptPanel";
import { DeliveryComposer } from "@/components/deliveries/DeliveryComposer";
import { EarningSummary } from "@/components/deliveries/EarningSummary";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { autoAcceptWindowLabel } from "@/lib/constants/deliveries";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadWorkerJobWork } from "@/lib/deliveries/queries";
import type { WorkerJobWork } from "@/lib/deliveries/types";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateShort, formatRemaining } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Deliver · Zevi" };

/**
 * One job the worker was picked for: the brief, what they have sent, and the
 * form to send more — spec §6's "Delivery".
 *
 * The brief and its attachments are readable here and nowhere else before
 * assignment: `job_attachments` follows `is_job_participant`, deliberately, so
 * this is the first screen where a worker sees what the client actually
 * uploaded.
 */
export default async function WorkerDeliverPage({
  params,
}: {
  params: Promise<{ jobId: string }>;
}) {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const { jobId } = await params;
  const work = await loadWorkerJobWork(supabase, context.user.id, jobId);

  // RLS decided this, not the line below: a job this worker was not assigned
  // never came back at all. 404 is what that should look like.
  if (!work) notFound();

  const openRevision = work.revisions.find((revision) => revision.status === "requested");
  const awaiting = work.deliveries.find((delivery) => delivery.status === "pending_review");

  return (
    <div className="space-y-6">
      <Link
        href={WORKER_ROUTES.work}
        className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
      >
        ← Your work
      </Link>

      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight">{work.title}</h1>
          <p className="shrink-0 text-lg font-semibold tabular-nums">
            {formatPaiseCompact(work.budgetPaise)}
          </p>
        </div>

        <p className="text-muted text-sm">
          {[
            work.categoryName,
            `for ${work.clientName}`,
            work.deadlineAt ? `due ${formatDateShort(work.deadlineAt)}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <StatusNotice work={work} />

      {openRevision ? (
        <section className="border-danger/40 bg-danger/8 space-y-2 rounded-xl border p-4">
          <h2 className="text-sm font-medium">
            {work.clientName} asked for changes
            <span className="text-muted font-normal">
              {" · "}
              {formatDate(openRevision.createdAt)}
            </span>
          </h2>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{openRevision.reason}</p>
          <p className="text-muted text-xs">
            This is the free revision. Send an updated delivery below and their review
            window starts again.
          </p>
        </section>
      ) : null}

      <section className="border-border rounded-xl border p-4">
        <h2 className="mb-2 text-sm font-medium">The brief</h2>
        {/* Stored as typed. `whitespace-pre-wrap` keeps the client's paragraphs
            without ever treating their text as markup. */}
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{work.description}</p>
      </section>

      {work.earning ? <EarningSummary earning={work.earning} /> : null}

      {work.canDeliver ? (
        <div className="border-border rounded-xl border p-4">
          <DeliveryComposer
            jobId={work.jobId}
            workerId={context.user.id}
            staged={work.staged}
            maxUploadBytes={work.maxUploadBytes}
            attempt={work.deliveries.length + 1}
            autoAcceptWindow={autoAcceptWindowLabel(work.budgetPaise)}
          />
        </div>
      ) : null}

      {work.deliveries.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">What you&apos;ve sent</h2>
          {work.deliveries.map((delivery) => (
            <DeliveryAttemptPanel
              key={delivery.id}
              delivery={delivery}
              viewer="worker"
              dimmed={delivery.status === "superseded"}
            />
          ))}
        </section>
      ) : null}

      {awaiting ? (
        <p className="text-muted text-xs">
          Keep your own copy — delivered files are removed from Zevi seven days after
          the job is accepted.
        </p>
      ) : null}
    </div>
  );
}

/** Where the job is, and what the worker is waiting on. */
function StatusNotice({ work }: { work: WorkerJobWork }) {
  const awaiting = work.deliveries.find((delivery) => delivery.status === "pending_review");

  if (awaiting) {
    return (
      <Alert tone="success">
        Delivered. {work.clientName} has until {formatDate(awaiting.autoAcceptAt)} to accept
        or ask for changes — {formatRemaining(awaiting.autoAcceptAt)}. If they say nothing
        it&apos;s accepted automatically and the money is released to you.
      </Alert>
    );
  }

  if (work.status === "completed") {
    const accepted = work.deliveries.find((delivery) => delivery.status === "accepted");

    return (
      <Alert tone="success">
        {accepted?.autoAccepted
          ? "Accepted automatically — the review window ran out."
          : `${work.clientName} accepted your work.`}{" "}
        The money has been released to your balance.
      </Alert>
    );
  }

  if (work.status === "disputed") {
    return <Alert tone="error">This job is in dispute. We&apos;ll be in touch.</Alert>;
  }

  if (work.status === "cancelled") {
    return <Alert>This job was cancelled.</Alert>;
  }

  if (work.deadlineAt) {
    return (
      <Alert>
        Due {formatDate(work.deadlineAt)} — {formatRemaining(work.deadlineAt)}.
      </Alert>
    );
  }

  return null;
}
