import type { ReactNode } from "react";

import { AppHeader } from "@/components/AppHeader";
import { requireRole } from "@/lib/auth/session";

/**
 * Client surfaces (spec §5). The guard here decides what renders; RLS decides
 * what the queries inside are allowed to return.
 */
export default async function ClientLayout({ children }: { children: ReactNode }) {
  const context = await requireRole("client");

  return (
    <div className="min-h-screen">
      <AppHeader name={context.profile.display_name ?? context.profile.full_name} />
      <main className="mx-auto max-w-4xl px-4 py-10">{children}</main>
    </div>
  );
}
