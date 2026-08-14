import type { Metadata } from "next";

import { requireRole } from "@/lib/auth/session";
import { formatMobile } from "@/lib/utils/validation";

export const metadata: Metadata = { title: "Dashboard · Zevi" };

/**
 * Placeholder. Spec §5 puts active jobs, work awaiting review, past jobs,
 * payments and receipts here — none of which exist yet. It stands in as the
 * place signup lands, and says so honestly rather than faking a product.
 */
export default async function ClientDashboardPage() {
  const context = await requireRole("client");

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          You&apos;re set up, {context.profile.display_name ?? context.profile.full_name}
        </h1>
        <p className="text-muted text-sm">
          Your account is verified and ready. Posting a job is the next thing we&apos;re
          building.
        </p>
      </div>

      <dl className="border-border divide-border divide-y rounded-xl border text-sm">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <dt className="text-muted">Email</dt>
          <dd className="text-right">{context.profile.email}</dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <dt className="text-muted">Mobile</dt>
          <dd className="text-right">
            {context.profile.mobile ? formatMobile(context.profile.mobile) : "—"}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <dt className="text-muted">Both verified</dt>
          <dd className="text-success text-right">Yes</dd>
        </div>
      </dl>
    </div>
  );
}
