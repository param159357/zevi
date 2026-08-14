import Link from "next/link";
import { redirect } from "next/navigation";

import { AUTH_ROUTES } from "@/lib/constants/auth";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;

  // Safety net: if the project's redirect allow list hasn't been widened past
  // the Site URL, Supabase drops the confirmation code here instead of on
  // /auth/callback. Forward it rather than silently losing the confirmation.
  if (code) {
    redirect(`${AUTH_ROUTES.callback}?code=${encodeURIComponent(code)}`);
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Zevi</h1>
        <p className="text-muted text-sm">Marketplace for small digital work.</p>
      </div>

      <div className="flex items-center gap-3">
        <Link
          href={AUTH_ROUTES.signup}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2.5 text-sm font-medium"
        >
          Get started
        </Link>
        <Link
          href={AUTH_ROUTES.login}
          className="border-border rounded-lg border px-4 py-2.5 text-sm font-medium"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
