import type { ReactNode } from "react";
import Link from "next/link";

import { SignOutButton } from "@/components/auth/SignOutButton";
import { requireAdmin } from "@/lib/admin/session";
import { ADMIN_ROUTES } from "@/lib/constants/workers";

/**
 * The console (spec §7). `requireAdmin` decides what renders — and 404s anyone
 * without the permission rather than admitting the route exists — while the
 * `admin_can(...)` policies decide what the queries inside can return and each
 * decision function re-checks the permission for itself.
 *
 * Single super-admin at launch, but the permission is named at every layer, so
 * a support account that should never see worker PII cannot be given it by
 * accident later.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const context = await requireAdmin("review_workers");

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

      <main className="mx-auto max-w-5xl px-4 py-10">{children}</main>
    </div>
  );
}
