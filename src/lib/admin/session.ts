/**
 * Who is allowed into the console.
 *
 * Server-only, and the same relationship to RLS as `lib/auth/session.ts`: this
 * decides what renders, the policies decide what any query returns, and the
 * service-role functions behind each decision re-check the permission for
 * themselves. Three checks, because the console is the one surface where a
 * mistake is silent — an over-permissive page shows a support account someone
 * else's PII and nothing errors.
 *
 * A signed-in non-admin gets a 404 rather than a redirect. There is no reason
 * to tell an ordinary account that `/admin` is a thing that exists.
 */

import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import { type AuthContext, requireUser } from "@/lib/auth/session";
import { AUTH_ROUTES } from "@/lib/constants/auth";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database.types";

export type AdminPermission = Database["public"]["Enums"]["admin_permission"];

/**
 * `admin_users` has RLS enabled and no policies at all — membership is granted
 * out of band with the service-role key, never through the API — so the only
 * way to ask is the security-definer helper 0002 grants to `authenticated`.
 *
 * Cached per request: a layout, its page and each guard inside ask the same
 * question, and every miss is a round trip.
 */
export const adminCan = cache(async (permission: AdminPermission): Promise<boolean> => {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("admin_can", { perm: permission });

  if (error) throw new Error(`admin_can(${permission}) failed: ${error.message}`);

  return data === true;
});

export async function requireAdmin(permission: AdminPermission): Promise<AuthContext> {
  const context = await requireUser();

  if (context.isBlocked) redirect(`${AUTH_ROUTES.login}?notice=blocked`);

  if (!(await adminCan(permission))) notFound();

  return context;
}

/**
 * Membership only — for the console's shell, which has to render before any one
 * queue's permission is relevant.
 *
 * The layout used to demand `review_workers`, which was fine while worker
 * approvals was the only module and wrong the moment a second one landed: the
 * seeded `finance` role carries `manage_payouts` and `view_finance` and would
 * have 404'd on the whole console, KYC queue included. Each page still names the
 * permission it needs, and the policies behind them still decide what the
 * queries return.
 */
export const isAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("is_admin");

  if (error) throw new Error(`is_admin() failed: ${error.message}`);

  return data === true;
});

export async function requireAnyAdmin(): Promise<AuthContext> {
  const context = await requireUser();

  if (context.isBlocked) redirect(`${AUTH_ROUTES.login}?notice=blocked`);

  if (!(await isAdmin())) notFound();

  return context;
}
