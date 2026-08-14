import Link from "next/link";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link href="/" className="mb-8 text-2xl font-semibold tracking-tight">
        Zevi
      </Link>

      <main className="w-full max-w-md">{children}</main>

      <p className="text-muted mt-8 text-xs">
        Small digital work, done properly.
      </p>
    </div>
  );
}
