import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { AUTH_ROUTES } from "@/lib/constants/auth";
import { isSupabaseConfigured, publicEnv } from "@/lib/env";
import type { Database } from "@/types/database.types";

/**
 * Paths that make no sense without a session. This is a redirect, not a
 * defence: the layout under each of these re-checks server-side, and RLS
 * decides what any query can actually see.
 *
 * `/verify/email` is deliberately absent — email is confirmed before Supabase
 * issues a session, so that screen has to work signed out. So is
 * `/reset-password`, for a related reason: someone arriving on a stale recovery
 * link needs to be told the link is stale, not sent to a login screen asking for
 * the password they came to replace. That page makes its own check.
 */
const SIGNED_IN_ONLY = [
  "/dashboard",
  "/worker",
  "/admin",
  AUTH_ROUTES.verifyMobile,
  AUTH_ROUTES.workerCategories,
];

function requiresSession(pathname: string): boolean {
  return SIGNED_IN_ONLY.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Refreshes the Supabase auth session on every request and writes the rotated
 * cookies onto the response. Without this, Server Components see expired
 * tokens and users get logged out at random.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  // Before Supabase is configured, let dev requests through instead of 500ing
  // every page. In production a missing key is a real failure — throw.
  if (!isSupabaseConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Supabase environment variables are missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.",
      );
    }
    console.warn(
      "[supabase] No credentials found — skipping session refresh. Copy .env.example to .env.local.",
    );
    return response;
  }

  const supabase = createServerClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not put code between createServerClient and getUser(). getUser()
  // revalidates the token with Supabase; anything in between can read a stale
  // session and make the refresh non-deterministic.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && requiresSession(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = AUTH_ROUTES.login;
    url.search = "";
    url.searchParams.set("next", pathname);

    const redirect = NextResponse.redirect(url);
    // Carry the refreshed cookies over, or the next request starts from the
    // stale session this one just replaced.
    response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));

    return redirect;
  }

  return response;
}
