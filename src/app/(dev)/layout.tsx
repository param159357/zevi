import type { ReactNode } from "react";
import { notFound } from "next/navigation";

/**
 * Development-only screens.
 *
 * The fourth kind of route group after `(client)`, `(worker)`, `(admin)` and
 * `(shared)`, and the only one whose boundary is the environment rather than a
 * role. The guard is here rather than on each page for the reason every other
 * guard in this codebase is in a layout: a screen added to this subtree later
 * inherits it, instead of depending on somebody remembering.
 *
 * `notFound()` rather than a redirect, and rather than nothing: these pages are
 * not secret, but a production URL that renders sample invoices is a URL that
 * will eventually be sent to somebody as evidence of something. At build time
 * this makes the route prerender as a 404 and ship as static output.
 */
export default function DevLayout({ children }: { children: ReactNode }) {
  if (process.env.NODE_ENV === "production") notFound();

  return children;
}
