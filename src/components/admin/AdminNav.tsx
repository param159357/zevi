"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { cn } from "@/lib/utils/cn";

/**
 * The console's queues — the two of spec §7's five that exist.
 *
 * A Client Component only because marking the current one needs the pathname.
 * Which tabs are here at all is decided on the server, by the layout, from the
 * account's permissions: a queue whose page would 404 is not shown, so the nav
 * never offers a door that does not open.
 */
export function AdminNav({
  canReviewWorkers,
  canManagePayouts,
}: {
  canReviewWorkers: boolean;
  canManagePayouts: boolean;
}) {
  const pathname = usePathname();

  const links = [
    canReviewWorkers ? { href: ADMIN_ROUTES.approvals, label: "Worker approvals" } : null,
    canManagePayouts ? { href: ADMIN_ROUTES.kyc, label: "KYC review" } : null,
  ].flatMap((link) => (link ? [link] : []));

  if (links.length < 2) return null;

  return (
    <nav aria-label="Console" className="border-border border-b">
      <ul className="mx-auto flex max-w-5xl gap-1 px-4">
        {links.map((link) => {
          const active = pathname.startsWith(link.href);

          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-block border-b-2 px-3 py-2.5 text-sm transition-colors",
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
