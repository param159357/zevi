import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { publicEnv, serverEnv } from "@/lib/env";
import type { Database } from "@/types/database.types";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Runs as the signed-in user and is still subject to RLS.
 *
 * Create it per request — never hoist it to a module-level singleton, or one
 * user's session leaks into another's request.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    publicEnv.supabaseUrl,
    publicEnv.supabaseAnonKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, which cannot set cookies. Safe to
            // ignore: the middleware refreshes the session on every request.
          }
        },
      },
    },
  );
}

/**
 * Supabase client that bypasses RLS entirely.
 *
 * Only for trusted server-side work that genuinely cannot run as a user:
 * payout batches, webhook handlers, admin tooling, background jobs. Never
 * import this into anything that reaches the browser, and never use it to skip
 * writing an RLS policy.
 */
export function createServiceRoleClient() {
  return createServerClient<Database>(
    publicEnv.supabaseUrl,
    serverEnv.supabaseServiceRoleKey,
    {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {
          // Service-role client is stateless — it must not touch session cookies.
        },
      },
    },
  );
}
