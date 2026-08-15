import type { Metadata } from "next";
import Link from "next/link";

import { KycForm } from "@/components/workers/KycForm";
import { KycRefresh } from "@/components/workers/KycRefresh";
import { Alert } from "@/components/ui/Alert";
import { requireRole } from "@/lib/auth/session";
import { KYC_MAX_ATTEMPTS, PAN_REQUIRED_ABOVE_PAISE } from "@/lib/constants/kyc";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadWorkerKyc } from "@/lib/kyc/queries";
import type { KycOverview } from "@/lib/kyc/types";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";
import { formatPaiseCompact } from "@/lib/utils/money";

export const metadata: Metadata = { title: "Getting paid · Zevi" };

/**
 * Spec §6, "KYC — before first payout, not at signup".
 *
 * The screen a worker reaches from their earnings when they want to know why the
 * money hasn't arrived. It asks for four things, sends ₹1 to the account to find
 * out whose name is on it, and — this is the part the copy has to carry — refuses
 * permanently if that name isn't theirs.
 *
 * There is no version of this page that hides what it is doing. A worker is
 * handing over their PAN and their bank account; they are owed the plain
 * description of what happens to both.
 */
export default async function WorkerKycPage() {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const kyc = await loadWorkerKyc(supabase, context.user.id);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Getting paid</h1>
        <p className="text-muted text-sm">
          Before your first payout we have to confirm the account it goes to, and that
          the name on it is yours. It takes a couple of minutes and you only do it once.
        </p>
      </div>

      {!kyc.configured ? (
        <Alert tone="info">
          Bank verification isn&apos;t switched on yet, so there&apos;s nothing to fill in
          here. Everything you&apos;ve earned stays yours and rolls into the next cycle —
          nothing expires.
        </Alert>
      ) : (
        <Body kyc={kyc} />
      )}

      <WhatWeKeep />
    </div>
  );
}

function Body({ kyc }: { kyc: KycOverview }) {
  if (kyc.status === "verified") return <Verified kyc={kyc} />;
  if (kyc.status === "blocked") return <Blocked kyc={kyc} />;
  if (kyc.status === "verifying") return <InFlight kyc={kyc} />;
  if (kyc.attemptsLeft === 0) return <InReview kyc={kyc} />;

  return (
    <div className="space-y-5">
      {kyc.lastFailureReason ? (
        <Alert tone="error">
          {kyc.lastFailureReason} You have {kyc.attemptsLeft}{" "}
          {kyc.attemptsLeft === 1 ? "attempt" : "attempts"} left.
        </Alert>
      ) : null}

      {kyc.panRequired && !kyc.panVerificationAvailable ? (
        <Alert tone="error">
          You&apos;ve earned over {formatPaiseCompact(PAN_REQUIRED_ABOVE_PAISE)}, so PAN is
          required for TDS — and we can&apos;t check one yet. Write to support and
          we&apos;ll sort it out; your earnings keep rolling forward meanwhile.
        </Alert>
      ) : null}

      <KycForm
        defaults={{ legalName: kyc.legalName, dateOfBirth: kyc.dateOfBirth }}
        panRequired={kyc.panRequired}
        panAvailable={kyc.panVerificationAvailable}
        attemptsLeft={kyc.attemptsLeft}
      />
    </div>
  );
}

/** Verified: the destination, and the one sentence the worker came for. */
function Verified({ kyc }: { kyc: KycOverview }) {
  return (
    <div className="space-y-4">
      <div className="border-success/40 bg-success/8 space-y-1 rounded-xl border p-5">
        <p className="text-success text-sm font-medium">Verified</p>
        <p className="text-sm">
          {kyc.verifiedAt ? `Confirmed ${formatDate(kyc.verifiedAt)}. ` : ""}
          Your payouts go to {describeDestination(kyc)}.
        </p>
      </div>

      <p className="text-muted text-sm">
        Payouts run twice a week — a cycle closes Wednesday midnight and pays Friday, and
        closes Sunday midnight and pays Tuesday.{" "}
        <Link
          href={WORKER_ROUTES.earnings}
          className="text-foreground underline underline-offset-4"
        >
          See what&apos;s due
        </Link>
        .
      </p>

      {kyc.duplicatePanFlagged ? (
        <Alert tone="info">
          That PAN is on another Zevi account too. Someone will check it — you don&apos;t
          need to do anything, and your payouts aren&apos;t on hold for it.
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Blocked, which is the end of it. Spec §6: name mismatch = blocked, no
 * override — so this page does not offer a retry, a form, or a hint that
 * writing in might change the answer about the name itself.
 */
function Blocked({ kyc }: { kyc: KycOverview }) {
  return (
    <div className="space-y-4">
      <Alert tone="error">
        {kyc.blockedReason ??
          "The name on the account you sent isn't the name on this profile."}
      </Alert>

      <p className="text-muted text-sm">
        We can only pay an account that belongs to you, and that check can&apos;t be
        overridden by anyone here. If you think we&apos;ve got it wrong — a bank holding an
        old name, a name we&apos;ve read incorrectly — write to support with your account
        details and they&apos;ll look at it.
      </p>

      {kyc.pennyDropName ? (
        <dl className="border-border divide-border divide-y rounded-xl border text-sm">
          <NameRow label="The name you gave us" value={kyc.legalName} />
          <NameRow label="The name on the account" value={kyc.pennyDropName} />
          {kyc.panRegisteredName ? (
            <NameRow label="The name on the PAN" value={kyc.panRegisteredName} />
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/** The penny drop is out and the bank hasn't answered. */
function InFlight({ kyc }: { kyc: KycOverview }) {
  return (
    <div className="space-y-4">
      <div className="border-border bg-surface-muted space-y-1 rounded-xl border p-5">
        <p className="text-sm font-medium">Checking with your bank</p>
        <p className="text-muted text-sm">
          We&apos;ve sent ₹1 to {describeDestination(kyc)} to see whose name is on it. This
          usually takes a couple of minutes — you can close this page and come back.
        </p>
      </div>

      <KycRefresh />
    </div>
  );
}

/** Three attempts spent. Spec §6 hands it to a person at this point. */
function InReview({ kyc }: { kyc: KycOverview }) {
  return (
    <div className="space-y-4">
      <Alert tone="info">
        {kyc.lastFailureReason ? `${kyc.lastFailureReason} ` : ""}
        That was your {KYC_MAX_ATTEMPTS === kyc.attempts ? "third" : "last"} attempt, so
        someone here is looking at it. You don&apos;t need to do anything.
      </Alert>

      <p className="text-muted text-sm">
        Nothing you&apos;ve earned is affected. It keeps rolling into the next cycle and
        will be paid once the account is confirmed.
      </p>
    </div>
  );
}

function NameRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
      <dt className="text-muted text-xs">{label}</dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}

function describeDestination(kyc: KycOverview): string {
  const destination = kyc.destination;
  if (!destination) return "your account";

  if (destination.type === "upi") return destination.upiMasked ?? "your UPI ID";

  const bank = destination.bankName ?? destination.ifsc?.slice(0, 4) ?? "your bank";

  return destination.accountLast4
    ? `${bank}, the account ending ${destination.accountLast4}`
    : bank;
}

/**
 * What happens to a PAN and an account number, in the place a worker is being
 * asked for them. Spec §12 governs retention; this is the same fact in the
 * second person.
 */
function WhatWeKeep() {
  return (
    <div className="border-border space-y-2 rounded-xl border border-dashed p-5">
      <h2 className="text-sm font-medium">What we keep</h2>
      <p className="text-muted text-sm">
        Your full PAN and full account number go to our payments provider and are never
        stored here. We keep the last four digits, so you can tell which account is which,
        and a one-way fingerprint we use to spot the same PAN or the same bank account
        being used by two people. Neither can be turned back into the original.
      </p>
    </div>
  );
}
