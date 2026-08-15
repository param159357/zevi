import type { Metadata } from "next";

import { KycReviewForm } from "@/components/admin/KycReviewForm";
import { Alert } from "@/components/ui/Alert";
import { loadKycQueue } from "@/lib/admin/queries";
import { requireAdmin } from "@/lib/admin/session";
import { KYC_MAX_ATTEMPTS } from "@/lib/constants/kyc";
import { type KycAttentionReason, type KycQueueRow, isKycReviewDecision } from "@/lib/kyc/types";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatTime } from "@/lib/utils/format";

export const metadata: Metadata = { title: "KYC review · Zevi" };

const DECIDED: Record<string, string> = {
  allow_retry: "Attempts reset. They can submit an account again.",
  reject: "Rejected, and the account on file is disabled.",
};

const REASON_LABELS: Record<KycAttentionReason, string> = {
  attempts_spent: `${KYC_MAX_ATTEMPTS} failed attempts`,
  duplicate_pan: "PAN on another account",
  stuck_verifying: "Penny drop hasn't come back",
};

/**
 * The KYC queue (spec §6, §7).
 *
 * Three things land a worker here — attempts spent, a PAN that is on someone
 * else's account, or a penny drop that never returned — and each is a different
 * problem, so each row says which. What does not land here is a blocked account:
 * spec §6 makes a name mismatch terminal, there is nothing left to decide, and a
 * work queue full of decisions nobody may make is how a rule with no override
 * quietly acquires one.
 *
 * Everything on the screen is either a name under review or a last-four. The
 * full PAN and full account number were never stored (migration 0033), so there
 * is nothing here for this page to leak even to someone who should see it.
 */
export default async function KycQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ reviewed?: string }>;
}) {
  await requireAdmin("manage_payouts");
  const supabase = await createClient();

  const [{ reviewed }, queue] = await Promise.all([searchParams, loadKycQueue(supabase)]);

  return (
    <div className="space-y-8">
      {reviewed && isKycReviewDecision(reviewed) ? (
        <Alert tone="success">{DECIDED[reviewed]}</Alert>
      ) : null}

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">KYC review</h1>
        <p className="text-muted text-sm">
          {queue.length === 0
            ? "Nothing waiting. Workers appear here after three failed attempts, on a duplicate PAN, or when a penny drop doesn't come back."
            : `${queue.length} waiting, oldest first.`}
        </p>
      </div>

      {queue.length === 0 ? null : (
        <ul className="space-y-4">
          {queue.map((row) => (
            <QueueEntry key={row.workerId} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function QueueEntry({ row }: { row: KycQueueRow }) {
  return (
    <li className="border-border space-y-4 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{row.displayName}</p>
          <p className="text-muted text-xs">
            {row.status} · {row.attempts}{" "}
            {row.attempts === 1 ? "attempt" : "attempts"}
            {row.panLast4 ? ` · PAN ••${row.panLast4}` : ""}
            {row.submittedAt
              ? ` · ${formatDate(row.submittedAt)}, ${formatTime(row.submittedAt)}`
              : ""}
          </p>
        </div>

        <ul className="flex shrink-0 flex-wrap gap-1.5">
          {row.reasons.map((reason) => (
            <li
              key={reason}
              className="border-border text-muted rounded-full border px-2 py-0.5 text-xs"
            >
              {REASON_LABELS[reason]}
            </li>
          ))}
        </ul>
      </div>

      {/* The three names, side by side, which is the whole of the evidence. */}
      <dl className="border-border divide-border divide-y rounded-lg border text-sm">
        <NameRow label="Declared" value={row.legalName} />
        <NameRow label="On the account" value={row.pennyDropName} />
        <NameRow label="On the PAN" value={row.panRegisteredName} />
        {row.nameMatchScore !== null ? (
          <NameRow label="Match score" value={row.nameMatchScore.toFixed(3)} />
        ) : null}
      </dl>

      {row.lastFailureReason ? (
        <p className="text-muted text-xs">Last failure: {row.lastFailureReason}</p>
      ) : null}

      {row.duplicatePanFlagged ? (
        <Alert tone="info">
          This PAN is on at least one other account. Spec §6 flags a duplicate rather than
          refusing it — a household sharing a PAN and a ring look the same from here.
          Verification is not held up by the flag; rejecting is what stops it.
        </Alert>
      ) : null}

      <KycReviewForm workerId={row.workerId} />
    </li>
  );
}

function NameRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
      <dt className="text-muted text-xs">{label}</dt>
      <dd>{value ?? "—"}</dd>
    </div>
  );
}
