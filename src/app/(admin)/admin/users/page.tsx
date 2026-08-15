import type { Metadata } from "next";
import Link from "next/link";

import { requireAdmin } from "@/lib/admin/session";
import { searchUsers } from "@/lib/admin/users";
import type { UserSearchRow } from "@/lib/admin/types";
import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Users · Zevi" };

/**
 * Spec §7's Users module, found by search rather than browsed.
 *
 * `profiles` is every account on the platform and it is the PII table — 0027
 * lets `manage_users` read it because the approval and support screens have to,
 * not so the console can page through it. A search box makes the intent of each
 * read a person's decision; an infinite list makes it a habit.
 *
 * The form is a plain GET with no `onChange` handler, so this page ships no
 * route-specific JavaScript and the query lives in the URL where it can be
 * shared and reloaded.
 */
export default async function UserSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireAdmin("manage_users");
  const supabase = await createClient();

  const { q } = await searchParams;
  const term = (q ?? "").trim();
  const results = await searchUsers(supabase, term);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
        <p className="text-muted text-sm">
          Search by name or email. Everything you open here is logged against your account.
        </p>
      </div>

      <form method="get" className="flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={term}
          placeholder="Name or email"
          aria-label="Search by name or email"
          className={cn(
            "bg-surface border-border w-full rounded-lg border px-3 py-2.5 text-sm outline-none",
            "placeholder:text-muted/70",
            "focus-visible:ring-accent focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
        />
        <button
          type="submit"
          className="bg-primary text-primary-foreground shrink-0 rounded-lg px-4 py-2.5 text-sm font-medium hover:opacity-90"
        >
          Search
        </button>
      </form>

      <div className="space-y-3">
        <p className="text-muted text-sm">
          {term.length > 0 && term.length < 2
            ? "Two characters at least — otherwise this is just a list of everyone."
            : results.length === 0
              ? "Nobody matched."
              : term
                ? `${results.length} matched.`
                : `The ${results.length} newest accounts.`}
        </p>

        {results.length === 0 ? null : (
          <ul className="divide-border border-border divide-y rounded-xl border">
            {results.map((row) => (
              <ResultRow key={row.profileId} row={row} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ResultRow({ row }: { row: UserSearchRow }) {
  const roles = [row.isClient ? "client" : null, row.isWorker ? "worker" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li>
      <Link
        href={ADMIN_ROUTES.user(row.profileId)}
        className="hover:bg-surface-muted flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 transition-colors"
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.fullName}</p>
          <p className="text-muted truncate text-xs">
            {row.email}
            {roles ? ` · ${roles}` : " · no role yet"} · joined {formatDate(row.createdAt)}
          </p>
        </div>

        <StatusPill status={row.status} />
      </Link>
    </li>
  );
}

function StatusPill({ status }: { status: string }) {
  const restricted = status !== "active";

  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-xs",
        restricted ? "border-danger/40 text-danger" : "border-border text-muted",
      )}
    >
      {status}
    </span>
  );
}
