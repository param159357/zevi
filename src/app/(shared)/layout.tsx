import type { ReactNode } from "react";

import { AppHeader } from "@/components/AppHeader";
import { requireUser } from "@/lib/auth/session";

/**
 * Surfaces both sides of a job share.
 *
 * Every other route group guards on a role — `(client)` calls
 * `requireRole("client")`, `(worker)` the other one — and a dispute cannot,
 * because spec §11's first rule is that either side may raise one and both
 * sides read the same case. A role guard here would lock out whichever party
 * did not happen to be picked, which is exactly half of them.
 *
 * So the guard is `requireUser()`: signed in, verified, not blocked. Who may
 * read *this* case is then decided where it should be — by RLS, through
 * `both sides read the dispute` and `is_dispute_party`, and the page 404s on
 * the empty result rather than on a check of its own.
 */
export default async function SharedLayout({ children }: { children: ReactNode }) {
  const context = await requireUser();

  return (
    <div className="min-h-screen">
      <AppHeader name={context.profile.display_name ?? context.profile.full_name} />
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
    </div>
  );
}
