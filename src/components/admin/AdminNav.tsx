"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { cn } from "@/lib/utils/cn";

/**
 * The console's modules (spec §7).
 *
 * A Client Component only because marking the current one needs the pathname.
 * *Which* tabs exist at all is decided on the server, by the layout, from the
 * account's permissions: a queue whose page would 404 is not shown, so the nav
 * never offers a door that does not open.
 *
 * Home is always here even when nothing else is, because it is the one screen
 * that renders something for every console role — a support account with only
 * `view_disputes` still sees its own queue counted there.
 */
export function AdminNav({
  canReviewWorkers,
  canManagePayouts,
  canViewDisputes,
  canManageUsers,
}: {
  canReviewWorkers: boolean;
  canManagePayouts: boolean;
  canViewDisputes: boolean;
  canManageUsers: boolean;
}) {
  const pathname = usePathname();

  const links = [
    { href: ADMIN_ROUTES.home, label: "Work queue", exact: true },
    canViewDisputes ? { href: ADMIN_ROUTES.disputes, label: "Disputes", exact: false } : null,
    canReviewWorkers
      ? { href: ADMIN_ROUTES.approvals, label: "Worker approvals", exact: false }
      : null,
    canManageUsers ? { href: ADMIN_ROUTES.users, label: "Users", exact: false } : null,
    canManagePayouts ? { href: ADMIN_ROUTES.payouts, label: "Payouts", exact: false } : null,
    canManagePayouts ? { href: ADMIN_ROUTES.kyc, label: "KYC review", exact: false } : null,
  ].flatMap((link) => (link ? [link] : []));

  if (links.length < 2) return null;

  return (
    <nav aria-label="Console" className="border-border border-b">
      <ul className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4">
        {links.map((link) => {
          // Home would match every path under /admin if it were a prefix test.
          const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);

          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-block border-b-2 px-3 py-2.5 text-sm whitespace-nowrap transition-colors",
                  active
                    ? "border-accent text-foreground"
                    : "text-muted hover:text-foreground border-transparent",
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
