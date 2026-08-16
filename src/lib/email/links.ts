/**
 * The one place a path becomes a link somebody can click from their inbox.
 *
 * A relative URL is meaningless in an email — there is no page it is relative
 * to — so every action in every template is absolute, built from `getSiteUrl()`
 * and one of the route constants. Going through a function rather than
 * concatenating at each call site means the trailing-slash handling and the
 * "did anyone remember the origin" question are answered once.
 */

import { getSiteUrl } from "@/lib/env";

export function absoluteUrl(path: string): string {
  return `${getSiteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
