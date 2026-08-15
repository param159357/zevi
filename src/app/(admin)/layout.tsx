import type { ReactNode } from "react";
import Link from "next/link";

import { AdminNav } from "@/components/admin/AdminNav";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { adminCan, requireAnyAdmin } from "@/lib/admin/session";
import { ADMIN_ROUTES } from "@/lib/constants/workers";

/**
 * The console (spec §7). The guard here 404s anyone who is not an admin at all
 * — rather than admitting the route exists — while each page names the
 * permission *it* needs, the `admin_can(...)` policies decide what the queries
 * inside can return, and each decision function re-checks the permission for
 * itself.
 *
 * Membership rather than a specific permission, deliberately. This layout used
 * to demand `review_workers`, which was indistinguishable from the right answer
 * while approvals was the only module and became wrong the moment KYC review
 * landed: the seeded `finance` role holds `manage_payouts` and would have 404'd
 * on the console it exists to use.
 *
 * Single super-admin at launch, but the permission is named at every layer, so
 * a support account that should never see worker PII cannot be given it by
 * accident later.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const context = await requireAnyAdmin();

  // What this account may open. A queue they cannot act on is not a tab — the
  // page would 404 and the nav would have been the thing that lied.
  const [canReviewWorkers, canManagePayouts] = await Promise.all([
    adminCan("review_workers"),
    adminCan("manage_payouts"),
  ]);

  return (
    <div className="min-h-screen">
      <header className="border-border border-b">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-baseline gap-3">
            <Link href={ADMIN_ROUTES.home} className="text-lg font-semibold tracking-tight">
              Zevi
            </Link>
            <span className="text-muted text-xs tracking-wide uppercase">Console</span>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-muted hidden text-sm sm:inline">
              {context.profile.full_name}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <AdminNav canReviewWorkers={canReviewWorkers} canManagePayouts={canManagePayouts} />

      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
    </div>
  );
}
