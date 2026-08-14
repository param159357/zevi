"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { WORKER_ROUTES } from "@/lib/constants/workers";
import { cn } from "@/lib/utils/cn";

const LINKS = [
  { href: WORKER_ROUTES.home, label: "Home" },
  { href: WORKER_ROUTES.feed, label: "Jobs" },
  { href: WORKER_ROUTES.optIns, label: "Opt-ins" },
  { href: WORKER_ROUTES.samples, label: "Samples" },
] as const;

/**
 * The worker's four surfaces. A Client Component only because marking the
 * current one needs the pathname — everything it renders is a plain link.
 *
 * Every destination re-checks who is asking; this is wayfinding, not access.
 */
export function WorkerNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Worker" className="border-border border-b">
      <ul className="mx-auto flex max-w-4xl gap-1 px-4">
        {LINKS.map((link) => {
          // `/worker` is the prefix of every other route, so it matches exactly
          // and the rest match their subtrees — a brief keeps "Jobs" lit.
          const active =
            link.href === WORKER_ROUTES.home
              ? pathname === link.href
              : pathname.startsWith(link.href);

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
