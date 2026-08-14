import Link from "next/link";

import { FEED_CATEGORY_PARAM } from "@/lib/constants/matching";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import type { FeedCategory } from "@/lib/matching/types";
import { cn } from "@/lib/utils/cn";

/**
 * Spec §6: the feed is filtered to the worker's categories. RLS already does
 * that much — this narrows it further, to one of the three.
 *
 * Links, not buttons: the filter is a URL, so it survives a refresh, a back
 * button and a shared tab, and the page stays a Server Component. There is no
 * client JavaScript on the feed at all, which is the point of the design rule
 * about screens a worker sees ten times a day.
 */
export function CategoryFilter({
  categories,
  activeCategoryId,
  total,
}: {
  categories: FeedCategory[];
  activeCategoryId: string | null;
  /** Open jobs across every category, for the "All" tab. */
  total: number;
}) {
  if (categories.length < 2) return null;

  const tabs = [
    { id: null, name: "All", jobCount: total },
    ...categories.map((category) => ({ ...category, id: category.id as string | null })),
  ];

  return (
    <nav aria-label="Filter by category" className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const active = tab.id === activeCategoryId;

        return (
          <Link
            key={tab.id ?? "all"}
            href={
              tab.id
                ? `${WORKER_ROUTES.feed}?${FEED_CATEGORY_PARAM}=${tab.id}`
                : WORKER_ROUTES.feed
            }
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs transition-colors",
              active
                ? "border-accent bg-surface-muted text-foreground"
                : "border-border text-muted hover:bg-surface-muted hover:text-foreground",
            )}
          >
            {tab.name}
            <span className="text-muted ml-1.5 tabular-nums">{tab.jobCount}</span>
          </Link>
        );
      })}
    </nav>
  );
}
