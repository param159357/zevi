import Link from "next/link";

import { SignOutButton } from "@/components/auth/SignOutButton";

export function AppHeader({ name }: { name: string }) {
  return (
    <header className="border-border border-b">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          Zevi
        </Link>

        <div className="flex items-center gap-3">
          <span className="text-muted hidden text-sm sm:inline">{name}</span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
