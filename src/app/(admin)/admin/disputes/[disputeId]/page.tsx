import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DisputeDecisionForm } from "@/components/admin/DisputeDecisionForm";
import { Alert } from "@/components/ui/Alert";
import { loadDisputeCase } from "@/lib/admin/disputes";
import { adminCan, requireAdmin } from "@/lib/admin/session";
import type { DisputeCase, DisputeFile, DisputeParty } from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import {
  formatBytes,
  formatCount,
  formatCountdown,
  formatDate,
  formatRating,
  formatTime,
} from "@/lib/utils/format";
import { formatBps, formatPaise } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Dispute · Zevi" };

/**
 * One case, on one screen (spec §7).
 *
 * "Brief, files, chat, both statements, both histories. Three actions: release ·
 * refund · split. Required internal note on every decision."
 *
 * Everything on this page is here because spec §11 budgets three minutes for a
 * decision and a reviewer who has to open four tabs takes twenty. The order is
 * the order a case is actually read in: what was asked for, what was sent, what
 * each side says about it, who they are, and only then the buttons.
 *
 * The chat is shown **unredacted**. `messages.body` is what the two parties saw;
 * `message_raw.body` is what was typed, and `admin_can('view_disputes')` is the
 * only thing that reads it. A case about off-platform contact is unarguable from
 * the second and invisible in the first.
 */
export default async function DisputeCasePage({
  params,
}: {
  params: Promise<{ disputeId: string }>;
}) {
  await requireAdmin("view_disputes");

  const [{ disputeId }, supabase, canResolve] = await Promise.all([
    params,
    createClient(),
    adminCan("resolve_disputes"),
  ]);

  const detail = await loadDisputeCase(supabase, disputeId);

  if (!detail) notFound();

  const decided = detail.outcome !== null;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link href={ADMIN_ROUTES.disputes} className="text-muted text-sm hover:underline">
          ← Disputes
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">{detail.jobTitle}</h1>

        <p className="text-muted text-sm">
          {formatPaise(detail.amountPaise)} in dispute · raised by the {detail.raisedByRole} on{" "}
          {formatDate(detail.openedAt)} · {detail.status.replace(/_/g, " ")}
          {detail.categoryName ? ` · ${detail.categoryName}` : ""}
        </p>
      </div>

      {decided ? (
        <Alert tone="success">
          Already decided: {detail.outcome}
          {detail.splitClientBps === null
            ? ""
            : ` (${formatBps(detail.splitClientBps)} to the client)`}
          {detail.decidedAt ? ` on ${formatDate(detail.decidedAt)}` : ""}.
          {detail.decisionNote ? ` — ${detail.decisionNote}` : ""}
        </Alert>
      ) : (
        <Deadlines detail={detail} />
      )}

      <Section title="What was asked for">
        <p className="text-sm whitespace-pre-wrap">{detail.jobDescription}</p>
        <dl className="border-border divide-border mt-3 divide-y rounded-lg border text-sm">
          <Row label="Budget" value={formatPaise(detail.budgetPaise)} />
          <Row
            label="Deadline"
            value={detail.deadlineAt ? formatDate(detail.deadlineAt) : "None set"}
          />
          <Row
            label="Delivered"
            value={
              detail.deliveredAt
                ? `${formatDate(detail.deliveredAt)}, ${formatTime(detail.deliveredAt)}`
                : "Nothing was delivered"
            }
          />
          <Row
            label="In escrow"
            value={
              detail.escrowHeldPaise === null
                ? "Settled — nothing held"
                : `${formatPaise(detail.escrowHeldPaise)} (${detail.escrowStatus})`
            }
          />
        </dl>
      </Section>

      <Section
        title="Why"
        note="The complaint as it was filed. 500 characters, one side's words."
      >
        <p className="text-sm whitespace-pre-wrap">{detail.reasonSummary}</p>
      </Section>

      <Section
        title="Files"
        note={
          detail.files.length === 0
            ? undefined
            : "Signed for ten minutes. The delivered work first, then whatever came with the brief."
        }
      >
        {detail.files.length === 0 ? (
          <p className="text-muted text-sm">
            Nothing was uploaded on either side — which spec §11 makes an automatic refund when
            it is the worker who sent nothing.
          </p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-lg border">
            {detail.files.map((file) => (
              <FileRow key={file.id} file={file} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Statements"
        note="Spec §11 requires one from each side, 500 characters, 24 hours to respond."
      >
        {detail.statements.length === 0 ? (
          <p className="text-muted text-sm">Neither side has filed one yet.</p>
        ) : (
          <ul className="space-y-3">
            {detail.statements.map((statement) => (
              <li key={statement.id} className="border-border rounded-lg border p-3">
                <p className="text-muted text-xs">
                  {statement.authorName} ({statement.authorRole}) ·{" "}
                  {formatDate(statement.createdAt)}
                  {statement.isAppeal ? " · appeal" : ""}
                </p>
                <p className="mt-1.5 text-sm whitespace-pre-wrap">{statement.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Chat"
        note="As it was typed, not as the other side saw it — the redaction count is on each line."
      >
        {detail.messages.length === 0 ? (
          <p className="text-muted text-sm">They never spoke on the platform.</p>
        ) : (
          <ul className="divide-border border-border max-h-96 divide-y overflow-y-auto rounded-lg border">
            {detail.messages.map((message) => (
              <li key={message.id} className="px-3 py-2">
                <p className="text-muted text-xs">
                  {message.senderRole} · {formatDate(message.createdAt)},{" "}
                  {formatTime(message.createdAt)}
                  {message.redactionCount > 0
                    ? ` · ${formatCount(message.redactionCount, "redaction")}`
                    : ""}
                </p>
                <p className="mt-0.5 text-sm whitespace-pre-wrap">{message.body}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Both histories">
        <div className="grid gap-3 sm:grid-cols-2">
          <PartyCard party={detail.client} fallback="No client on this job." />
          <PartyCard party={detail.worker} fallback="Nobody was assigned." />
        </div>
      </Section>

      {decided ? null : (
        <Section title="Decide">
          <DisputeDecisionForm
            disputeId={detail.disputeId}
            budgetPaise={detail.budgetPaise}
            escrowHeldPaise={detail.escrowHeldPaise}
            canResolve={canResolve}
          />
        </Section>
      )}
    </div>
  );
}

/** Spec §11 states both on screen: 48h to a first response, 5 days to a
 *  decision. Stored instants, so this counts rather than estimates. */
function Deadlines({ detail }: { detail: DisputeCase }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="border-border rounded-lg border p-3">
        <p className="text-muted text-xs">First response from Zevi</p>
        <p className="text-sm font-medium">{formatCountdown(detail.firstResponseDueAt)}</p>
      </div>
      <div className="border-border rounded-lg border p-3">
        <p className="text-muted text-xs">Decision due</p>
        <p className="text-sm font-medium">{formatCountdown(detail.decisionDueAt)}</p>
      </div>
    </div>
  );
}

function PartyCard({ party, fallback }: { party: DisputeParty | null; fallback: string }) {
  if (!party) {
    return (
      <div className="border-border rounded-lg border p-3">
        <p className="text-muted text-sm">{fallback}</p>
      </div>
    );
  }

  const rating = formatRating(party.rating);

  return (
    <div className="border-border space-y-1.5 rounded-lg border p-3">
      <p className="text-sm font-medium">
        {party.displayName} <span className="text-muted font-normal">({party.role})</span>
      </p>

      <p className="text-muted text-xs">
        {rating ? `${rating} (${formatCount(party.ratingCount, "rating")})` : "Not yet rated"} ·{" "}
        {formatCount(party.jobsCompleted, "job")} completed
        {party.jobsCancelled === null ? "" : ` · ${party.jobsCancelled} cancelled`}
        {party.memberSince ? ` · since ${formatDate(party.memberSince)}` : ""}
      </p>

      {party.disputesRaised === null ? (
        // `user_private_stats` is gated on `manage_users`, which a dispute
        // reviewer may not hold. Saying so beats rendering a zero.
        <p className="text-muted text-xs">
          Dispute history needs the <code>manage_users</code> permission.
        </p>
      ) : (
        <p className="text-muted text-xs">
          {party.disputesRaised} raised · {party.disputesAgainst} against them ·{" "}
          {party.disputesLost} lost
        </p>
      )}
    </div>
  );
}

function FileRow({ file }: { file: DisputeFile }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{file.name}</p>
        <p className="text-muted text-xs">
          {file.source === "delivery" ? "Delivered" : "With the brief"} · {file.mimeType} ·{" "}
          {formatBytes(file.sizeBytes)}
        </p>
      </div>

      {file.url ? (
        <a
          href={file.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent shrink-0 text-sm hover:underline"
        >
          Open
        </a>
      ) : (
        <span className="text-muted shrink-0 text-xs">Object gone</span>
      )}
    </li>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h2 className="text-lg font-medium tracking-tight">{title}</h2>
        {note ? <p className="text-muted text-xs">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
      <dt className="text-muted text-xs">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
