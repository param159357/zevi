import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured, publicEnv } from "@/lib/env";
import type { Database } from "@/types/database.types";

/**
 * Refreshes the Supabase auth session on every request and writes the rotated
 * cookies onto the response. Without this, Server Components see expired
 * tokens and users get logged out at random.
 *
 * Route protection is NOT handled here yet — add it once auth exists, and
 * still authorise in the data layer via RLS. Middleware is a convenience, not
 * a security boundary.
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
  await supabase.auth.getUser();

  return response;
}
