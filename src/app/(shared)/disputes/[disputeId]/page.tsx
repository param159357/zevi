import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatementForm } from "@/components/disputes/StatementForm";
import { RefundPanel } from "@/components/jobs/RefundPanel";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { DECISION_DAYS, RESPONSE_HOURS } from "@/lib/constants/disputes";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadDisputeForParty } from "@/lib/disputes/queries";
import type { DisputeView } from "@/lib/disputes/types";
import { loadJobRefunds } from "@/lib/refunds/queries";
import { createClient } from "@/lib/supabase/server";
import { formatCountdown, formatDate } from "@/lib/utils/format";
import { formatBps, formatPaise } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Your case · Zevi" };

/**
 * One case, as one of the two people in it sees it — spec §11.
 *
 * Deliberately not the console's screen with things removed. A participant sees
 * the statements, the clocks and the outcome; they do not see the other side's
 * history, the unredacted chat or the risk columns, and the reason they do not
 * is that `manage_users` and `view_disputes` gate those at the table level. This
 * page could not show them if it tried, which is the point of reading through
 * `loadDisputeForParty` rather than through `loadDisputeCase`.
 */
export default async function DisputeCasePage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  const context = await requireUser();
  const supabase = await createClient();

  const { disputeId } = await params;
  const view = await loadDisputeForParty(supabase, disputeId, context.user.id);

  // Someone else's case never came back from the query — RLS decided that, and
  // a 404 is what it should look like.
  if (!view) notFound();

  // Only the client's, and only once the case has been decided. `participants
  // read refunds` would hand a worker the same rows, but "your money back" is
  // not a sentence about them — the worker's half of a decision goes to their
  // earnings, not to a card.
  const refunds =
    view.viewerRole === "client" && view.outcome !== null
      ? await loadJobRefunds(supabase, view.jobId)
      : [];

  const backHref =
    view.viewerRole === "client" ? JOB_ROUTES.review(view.jobId) : WORKER_ROUTES.deliver(view.jobId);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link
          href={backHref}
          className="text-muted hover:text-foreground inline-block text-xs underline underline-offset-4"
        >
          ← {view.jobTitle}
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">
          {view.raisedByMe ? "The case you opened" : "A case was opened on this job"}
        </h1>

        <p className="text-muted text-sm">
          {formatPaise(view.amountPaise)} frozen · opened {formatDate(view.openedAt)}
        </p>
      </div>

      <Outcome view={view} />

      <RefundPanel refunds={refunds} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">What it is about</h2>
        <p className="border-border rounded-lg border px-3 py-2.5 text-sm">
          {view.reasonSummary}
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Statements</h2>

        {view.statements.length === 0 ? (
          <p className="text-muted text-sm">Nothing has been filed yet.</p>
        ) : (
          <ul className="space-y-3">
            {view.statements.map((statement) => (
              <li key={statement.id} className="border-border rounded-lg border p-3">
                <p className="text-muted text-xs">
                  {statement.isMine ? "You" : statement.authorName} ·{" "}
                  {formatDate(statement.createdAt)}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-wrap">
                  {statement.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {view.canRespond ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Your statement</h2>
          <StatementForm
            disputeId={view.disputeId}
            deadlineNote={`You have until ${formatDate(view.responseDueAt)} — ${RESPONSE_HOURS} hours from when this opened.`}
          />
        </section>
      ) : null}

      <p className="text-muted text-xs">
        Files, the brief and your messages on this job are all part of the case — you do
        not need to attach them again.
      </p>
    </div>
  );
}

/**
 * Where the case is, in the words of the person reading it.
 *
 * The three outcomes are stated from the viewer's own side, because "release"
 * and "refund" are our words for a decision and mean opposite things to the two
 * people it lands on.
 */
function Outcome({ view }: { view: DisputeView }) {
  if (view.outcome === null) {
    return (
      <div className="space-y-3">
        <Alert>
          The money on this job is frozen while it is decided. A decision is due by{" "}
          {formatDate(view.decisionDueAt)} — {formatCountdown(view.decisionDueAt)}, and we
          aim for {DECISION_DAYS} days from when a case opens.
        </Alert>

        {view.clientRefundCapBps !== null && view.viewerRole === "client" ? (
          <Alert>
            This came from cancelling more than half way through the deadline, so the most
            that can come back to you is {formatBps(view.clientRefundCapBps)} of the
            budget — {formatPaise(
              Math.floor((view.budgetPaise * view.clientRefundCapBps) / 10_000),
            )}
            .
          </Alert>
        ) : null}
      </div>
    );
  }

  const workerShare =
    view.outcome === "release"
      ? 10_000
      : view.outcome === "refund"
        ? 0
        : 10_000 - (view.splitClientBps ?? 0);

  const mine = view.viewerRole === "worker" ? workerShare : 10_000 - workerShare;
  const minePaise = Math.floor((view.amountPaise * mine) / 10_000);

  return (
    <div className="space-y-3">
      <Alert tone={mine > 0 ? "success" : "info"}>
        {mine === 10_000
          ? `Decided in your favour — the whole ${formatPaise(view.amountPaise)} is yours.`
          : mine === 0
            ? "Decided against you. None of the money on this job comes to you."
            : `Decided as a split — ${formatPaise(minePaise)} of ${formatPaise(view.amountPaise)} is yours.`}
        {view.decidedAt ? ` Decided on ${formatDate(view.decidedAt)}.` : ""}
      </Alert>

      {/* What used to be a promise about a refund in the abstract is now the
          `RefundPanel` above, reading the real row. Two statements about the
          same money is how they come to disagree. */}
      {view.decisionNote ? (
        <div className="border-border rounded-lg border p-3">
          <p className="text-muted text-xs">Why</p>
          <p className="mt-1 text-sm whitespace-pre-wrap">{view.decisionNote}</p>
        </div>
      ) : null}
    </div>
  );
}
