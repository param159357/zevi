import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LiftSanctionForm, SanctionForm } from "@/components/admin/SanctionForm";
import { Alert } from "@/components/ui/Alert";
import { requireAdmin } from "@/lib/admin/session";
import type { UserJob, UserSanction } from "@/lib/admin/types";
import { loadUserDetail } from "@/lib/admin/users";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatCount, formatDate, formatRating } from "@/lib/utils/format";
import { formatBps, formatPaise } from "@/lib/utils/money";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "User · Zevi" };

const APPLIED: Record<string, string> = {
  warning: "Warned. They are shown the reason.",
  suspension: "Suspended. They cannot sign in until it expires or you lift it.",
  ban: "Banned.",
  lifted: "Lifted. The account is active again unless something else is still holding it.",
};

/**
 * One account, whole (spec §7).
 *
 * "Full history, ratings, disputes, cancellations, earnings, KYC. Warn ·
 * suspend · ban. Every action logged with reason."
 *
 * This is the console's only screen that reads `profiles`, and the only one that
 * shows a legal name, an email and a mobile number together. That is the point
 * of the Users module and the reason `manage_users` is on the super admin alone
 * in the seeded roles — support does not need it to answer a ticket.
 */
export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ profileId: string }>;
  searchParams: Promise<{ applied?: string }>;
}) {
  await requireAdmin("manage_users");

  const [{ profileId }, { applied }, supabase] = await Promise.all([
    params,
    searchParams,
    createClient(),
  ]);

  const user = await loadUserDetail(supabase, profileId);

  if (!user) notFound();

  return (
    <div className="space-y-8">
      {applied && APPLIED[applied] ? <Alert tone="success">{APPLIED[applied]}</Alert> : null}

      <div className="space-y-2">
        <Link href={ADMIN_ROUTES.users} className="text-muted text-sm hover:underline">
          ← Users
        </Link>

        <h1 className="text-2xl font-semibold tracking-tight">{user.fullName}</h1>

        <p className="text-muted text-sm">
          {user.email}
          {user.emailVerifiedAt ? "" : " (unverified)"}
          {user.mobile ? ` · ${user.mobile}` : " · no mobile"}
          {user.mobile && !user.mobileVerifiedAt ? " (unverified)" : ""} · joined{" "}
          {formatDate(user.createdAt)}
        </p>
      </div>

      {user.status === "active" ? null : (
        <Alert tone="error">
          Account is {user.status}
          {user.statusReason ? ` — ${user.statusReason}` : ""}
          {user.suspendedUntil ? `, until ${formatDate(user.suspendedUntil)}` : ""}.
        </Alert>
      )}

      {user.isAdmin ? (
        <Alert tone="info">
          This account is a console member. It cannot be sanctioned from here —{" "}
          <code>apply_user_sanction()</code> refuses one, and membership is granted and revoked
          out of band with the service-role key.
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {user.client ? (
          <Panel title="As a client">
            <Row
              label="Rating"
              value={
                formatRating(user.client.rating)
                  ? `${formatRating(user.client.rating)} (${formatCount(user.client.ratingCount, "rating")})`
                  : "Not yet rated"
              }
            />
            <Row label="Jobs posted" value={String(user.client.jobsPosted)} />
            <Row label="Completed" value={String(user.client.jobsCompleted)} />
            <Row label="Cancelled" value={String(user.client.jobsCancelled)} />
            <Row label="Total spend" value={formatPaise(user.client.totalSpendPaise)} />
          </Panel>
        ) : null}

        {user.worker ? (
          <Panel title="As a worker">
            <Row label="Status" value={`${user.worker.status} · ${user.worker.tier}`} />
            <Row
              label="Rating"
              value={
                formatRating(user.worker.rating)
                  ? `${formatRating(user.worker.rating)} (${formatCount(user.worker.ratingCount, "rating")})`
                  : "Not yet rated"
              }
            />
            <Row label="Completed" value={String(user.worker.jobsCompleted)} />
            <Row label="Abandoned" value={String(user.worker.jobsAbandoned)} />
            <Row label="Active opt-ins" value={String(user.worker.activeOptIns)} />
            <Row label="KYC" value={user.worker.kycStatus ?? "not started"} />
            <Row
              label="Earned (lifetime)"
              value={formatPaise(user.worker.lifetimeEarningsPaise)}
            />
            <Row label="Paid out" value={formatPaise(user.worker.paidPaise)} />
            <Row label="Still owed" value={formatPaise(user.worker.pendingPaise)} />
            {user.worker.outstandingDebitPaise > 0 ? (
              <Row
                label="Outstanding debit"
                value={formatPaise(user.worker.outstandingDebitPaise)}
              />
            ) : null}
            {user.worker.earningsFrozen ? <Row label="Earnings" value="Frozen" /> : null}
          </Panel>
        ) : null}
      </div>

      {user.privateStats ? (
        <Panel title="Risk">
          <Row
            label="Disputes"
            value={`${user.privateStats.disputesRaised} raised · ${user.privateStats.disputesAgainst} against · ${user.privateStats.disputesLost} lost`}
          />
          <Row label="Dispute rate" value={formatBps(user.privateStats.disputeRateBps)} />
          <Row label="Chargebacks" value={String(user.privateStats.chargebacks)} />
          <Row label="Reports against" value={String(user.privateStats.reportsAgainst)} />
          <Row label="Risk score" value={`${user.privateStats.riskScore} / 100`} />
        </Panel>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-lg font-medium tracking-tight">Sanctions</h2>

        {user.sanctions.length === 0 ? (
          <p className="text-muted text-sm">Nothing on the record.</p>
        ) : (
          <ul className="space-y-3">
            {user.sanctions.map((sanction) => (
              <SanctionRow key={sanction.id} sanction={sanction} profileId={user.profileId} />
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium tracking-tight">Job history</h2>

        {user.jobs.length === 0 ? (
          <p className="text-muted text-sm">No published job on either side.</p>
        ) : (
          <ul className="divide-border border-border divide-y rounded-xl border">
            {user.jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        )}
      </section>

      {user.isAdmin ? null : (
        <section className="space-y-3">
          <div className="space-y-0.5">
            <h2 className="text-lg font-medium tracking-tight">Take action</h2>
            <p className="text-muted text-xs">
              Spec §7: every one of these is logged permanently, with the reason, against your
              account.
            </p>
          </div>

          <SanctionForm profileId={user.profileId} />
        </section>
      )}
    </div>
  );
}

function SanctionRow({
  sanction,
  profileId,
}: {
  sanction: UserSanction;
  profileId: string;
}) {
  const live =
    sanction.liftedAt === null &&
    (sanction.endsAt === null || new Date(sanction.endsAt).getTime() > Date.now());

  return (
    <li
      className={cn(
        "border-border space-y-2 rounded-xl border p-4",
        live && "border-danger/40 bg-danger/5",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">{sanction.type}</p>
        <p className="text-muted text-xs">
          {formatDate(sanction.startsAt)}
          {sanction.endsAt ? ` → ${formatDate(sanction.endsAt)}` : " · no end date"}
          {sanction.liftedAt ? ` · lifted ${formatDate(sanction.liftedAt)}` : ""}
        </p>
      </div>

      <p className="text-sm">{sanction.reason}</p>

      {sanction.internalNote ? (
        <p className="text-muted text-xs">Internal: {sanction.internalNote}</p>
      ) : null}

      {live ? <LiftSanctionForm sanctionId={sanction.id} profileId={profileId} /> : null}
    </li>
  );
}

function JobRow({ job }: { job: UserJob }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm">{job.title}</p>
        <p className="text-muted text-xs">
          as {job.role} · {job.status.replace(/_/g, " ")} · {formatDate(job.createdAt)}
        </p>
      </div>
      <p className="text-muted shrink-0 text-sm tabular-nums">{formatPaise(job.budgetPaise)}</p>
    </li>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-border rounded-xl border p-4">
      <h2 className="mb-2 text-sm font-medium">{title}</h2>
      <dl className="divide-border divide-y text-sm">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
      <dt className="text-muted text-xs">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
