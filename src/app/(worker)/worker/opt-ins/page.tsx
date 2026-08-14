import type { Metadata } from "next";
import Link from "next/link";

import { WithdrawOptIn } from "@/components/matching/WithdrawOptIn";
import { requireRole } from "@/lib/auth/session";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import {
  loadActiveOptIns,
  loadMatchingSettings,
  loadOptInCapacity,
} from "@/lib/matching/queries";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDate, formatDateShort } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Your opt-ins · Zevi" };

/**
 * The five slots, spelled out. Spec §6 caps active opt-ins and says nothing
 * about showing them, but a limit a worker cannot see is a limit they hit by
 * surprise — and the only way back under it is from here.
 */
export default async function WorkerOptInsPage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const settings = await loadMatchingSettings(supabase);
  const [optIns, capacity] = await Promise.all([
    loadActiveOptIns(supabase, context.user.id),
    loadOptInCapacity(supabase, context.user.id, settings.maxActiveOptIns),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Your opt-ins</h1>
        <p className="text-muted text-sm">
          {capacity.used} of {capacity.cap} slots in use. A slot frees up when the client
          picks someone, the job closes, or you withdraw.
        </p>
      </div>

      {optIns.length === 0 ? (
        <div className="border-border space-y-3 rounded-xl border border-dashed px-4 py-8 text-center">
          <p className="text-muted text-sm">You haven&apos;t opted into anything yet.</p>
          <Link
            href={WORKER_ROUTES.feed}
            className="text-foreground inline-block text-sm underline underline-offset-4"
          >
            Browse open jobs
          </Link>
        </div>
      ) : (
        <ul className="border-border divide-border divide-y rounded-xl border">
          {optIns.map((optIn) => (
            <li key={optIn.id} className="space-y-2 px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    href={WORKER_ROUTES.job(optIn.job.id)}
                    className="hover:text-accent block text-sm font-medium underline-offset-2 hover:underline"
                  >
                    {optIn.job.title}
                  </Link>

                  <p className="text-muted text-xs">
                    {[
                      optIn.job.categoryName,
                      optIn.job.budgetPaise != null
                        ? formatPaiseCompact(optIn.job.budgetPaise)
                        : null,
                      optIn.job.deadlineAt
                        ? `due ${formatDateShort(optIn.job.deadlineAt)}`
                        : null,
                      `opted in ${formatDate(optIn.createdAt)}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>

                {/* Shortlisted means a client is mid-decision. Withdrawing out
                    from under that is a behaviour spec §6 has no rule for yet. */}
                {optIn.status === "active" ? (
                  <WithdrawOptIn optInId={optIn.id} />
                ) : (
                  <span className="text-accent shrink-0 text-xs">Shortlisted</span>
                )}
              </div>

              <dl className="text-muted space-y-0.5 text-xs">
                <div className="flex gap-2">
                  <dt className="shrink-0">Software</dt>
                  <dd className="text-foreground min-w-0">{optIn.software}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">Turnaround</dt>
                  <dd className="text-foreground min-w-0">{optIn.turnaround}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="shrink-0">Noticed</dt>
                  <dd className="text-foreground min-w-0">{optIn.noticed}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}

      {capacity.atCap ? (
        <p className="text-muted text-xs">
          {formatCount(capacity.cap, "slot")} is the limit — it keeps opt-ins meaning
          something to the clients reading them.
        </p>
      ) : null}
    </div>
  );
}
