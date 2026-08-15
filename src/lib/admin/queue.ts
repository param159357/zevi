/**
 * The console's home (spec §7).
 *
 * "Home is a work queue, not a stats dashboard — ordered by what's rotting:
 * disputes past SLA, approvals nearing 24 hours, unassigned jobs about to
 * expire, failed payouts, flagged reports."
 *
 * That sentence is the whole design, and two things in it are worth saying out
 * loud because they are what a stats dashboard would get wrong:
 *
 *   * The ordering key is the **deadline**, not the count. Forty approvals with
 *     eighteen hours left is a calmer morning than one dispute four days into a
 *     five-day clock, and the sort at the bottom of this file says so.
 *   * A module the account cannot open is not on the screen. `loadWorkQueue`
 *     takes the permission set and asks only the questions it is allowed to
 *     ask, so a support account never gets a count it would 404 on clicking.
 *
 * Each queue is one `head: true` count plus one single-row ordered select for
 * the nearest deadline — both against the partial index that queue already has
 * (`disputes_queue_idx`, `worker_applications_queue_idx`, `jobs_expiry_idx`,
 * `payouts_failed_idx`). Five queues, ten cheap round trips, no result sets
 * fetched and thrown away.
 *
 * Written out one queue at a time rather than through a generic helper: five
 * tables with five row types and five different notions of "late" is exactly
 * the shape that a clever signature makes unreadable and `any` makes unsafe.
 */

import { ADMIN_ROUTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import type { QueueSummary } from "@/lib/admin/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** What the signed-in console account may open. */
export type ConsolePermissions = {
  reviewWorkers: boolean;
  viewDisputes: boolean;
  manageUsers: boolean;
  managePayouts: boolean;
  resolveReports: boolean;
};

/** Statuses `disputes_queue_idx` is partial on. */
const LIVE_DISPUTE_STATUSES = [
  "open",
  "awaiting_response",
  "admin_review",
  "appealed",
] as const;

/**
 * Jobs "about to expire" — spec §7's third line. The window is generous on
 * purpose: an open job with two days left is not yet a problem, and one with six
 * hours left and nobody opted in is the reason this line exists at all.
 */
const EXPIRY_WINDOW_HOURS = 48;

type Tally = Pick<QueueSummary, "count" | "overdue" | "nextDueAt">;

export async function loadWorkQueue(
  supabase: ServerSupabaseClient,
  permissions: ConsolePermissions,
): Promise<QueueSummary[]> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiryHorizon = new Date(now.getTime() + EXPIRY_WINDOW_HOURS * 3_600_000).toISOString();

  const [disputes, approvals, expiring, failedPayouts, reports] = await Promise.all([
    permissions.viewDisputes ? countDisputes(supabase, nowIso) : null,
    permissions.reviewWorkers ? countApprovals(supabase, nowIso) : null,
    permissions.manageUsers ? countExpiringJobs(supabase, nowIso, expiryHorizon) : null,
    permissions.managePayouts ? countFailedPayouts(supabase) : null,
    permissions.resolveReports ? countReports(supabase) : null,
  ]);

  const summaries: QueueSummary[] = [];

  if (disputes) {
    summaries.push({
      kind: "disputes",
      label: "Disputes",
      ...disputes,
      href: ADMIN_ROUTES.disputes,
      emptyNote: "No case is waiting on a decision.",
    });
  }

  if (approvals) {
    summaries.push({
      kind: "approvals",
      label: "Worker approvals",
      ...approvals,
      href: ADMIN_ROUTES.approvals,
      emptyNote: "Every submitted portfolio has been reviewed.",
    });
  }

  if (expiring) {
    summaries.push({
      kind: "expiring_jobs",
      label: "Jobs about to expire",
      ...expiring,
      // Spec §16 lists a job list in V1 and it is not built, so this line counts
      // and does not pretend to link anywhere. A number with no door is more
      // honest than a door that 404s.
      href: null,
      emptyNote: `No open job expires in the next ${EXPIRY_WINDOW_HOURS} hours.`,
    });
  }

  if (failedPayouts) {
    summaries.push({
      kind: "failed_payouts",
      label: "Failed payouts",
      ...failedPayouts,
      href: ADMIN_ROUTES.payouts,
      emptyNote: "No payout has come back failed.",
    });
  }

  if (reports) {
    summaries.push({
      kind: "reports",
      label: "Flagged reports",
      ...reports,
      href: null,
      emptyNote: "Nothing has been reported.",
    });
  }

  // What is rotting, first. Anything with something overdue outranks anything
  // without; inside each group the nearest deadline wins, and a queue with no
  // deadline at all sorts last rather than sorting as "now".
  return summaries.sort((a, b) => {
    if ((a.overdue > 0) !== (b.overdue > 0)) return a.overdue > 0 ? -1 : 1;
    if (a.nextDueAt && b.nextDueAt) return a.nextDueAt.localeCompare(b.nextDueAt);
    if (a.nextDueAt) return -1;
    if (b.nextDueAt) return 1;
    return b.count - a.count;
  });
}

/** Spec §11: five days to a decision, stored on the row so this can order by
 *  what is closest to breaching rather than by age. */
async function countDisputes(supabase: ServerSupabaseClient, nowIso: string): Promise<Tally> {
  const [{ count, error }, { count: overdue }, { data: nearest }] = await Promise.all([
    supabase
      .from("disputes")
      .select("id", { count: "exact", head: true })
      .in("status", LIVE_DISPUTE_STATUSES),
    supabase
      .from("disputes")
      .select("id", { count: "exact", head: true })
      .in("status", LIVE_DISPUTE_STATUSES)
      .lte("decision_due_at", nowIso),
    supabase
      .from("disputes")
      .select("decision_due_at")
      .in("status", LIVE_DISPUTE_STATUSES)
      .order("decision_due_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`Could not count disputes: ${error.message}`);

  return { count: count ?? 0, overdue: overdue ?? 0, nextDueAt: nearest?.decision_due_at ?? null };
}

/** Spec §6's 24-hour approval SLA, already stamped on the application. */
async function countApprovals(supabase: ServerSupabaseClient, nowIso: string): Promise<Tally> {
  const [{ count, error }, { count: overdue }, { data: nearest }] = await Promise.all([
    supabase
      .from("worker_applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted"),
    supabase
      .from("worker_applications")
      .select("id", { count: "exact", head: true })
      .eq("status", "submitted")
      .lte("sla_due_at", nowIso),
    supabase
      .from("worker_applications")
      .select("sla_due_at")
      .eq("status", "submitted")
      .order("sla_due_at", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`Could not count approvals: ${error.message}`);

  return { count: count ?? 0, overdue: overdue ?? 0, nextDueAt: nearest?.sla_due_at ?? null };
}

/**
 * Open jobs running out of time. Not a queue anyone can act on yet — there is
 * no job screen — but it is the line spec §7 puts third, and a client whose job
 * expired unmatched is the failure §17 says costs you that person forever.
 */
async function countExpiringJobs(
  supabase: ServerSupabaseClient,
  nowIso: string,
  horizon: string,
): Promise<Tally> {
  const [{ count, error }, { count: overdue }, { data: nearest }] = await Promise.all([
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .lte("expires_at", horizon),
    supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")
      .lte("expires_at", nowIso),
    supabase
      .from("jobs")
      .select("expires_at")
      .eq("status", "open")
      .lte("expires_at", horizon)
      .order("expires_at", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`Could not count expiring jobs: ${error.message}`);

  return { count: count ?? 0, overdue: overdue ?? 0, nextDueAt: nearest?.expires_at ?? null };
}

/**
 * Every failed payout is overdue the moment it fails — spec §14 has the worker
 * looking at a banner until someone acts — so there is no separate overdue
 * count here, and `nextDueAt` is when it broke rather than when it is due.
 */
async function countFailedPayouts(supabase: ServerSupabaseClient): Promise<Tally> {
  const [{ count, error }, { data: oldest }] = await Promise.all([
    supabase.from("payouts").select("id", { count: "exact", head: true }).eq("status", "failed"),
    supabase
      .from("payouts")
      .select("failed_at")
      .eq("status", "failed")
      .order("failed_at", { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`Could not count failed payouts: ${error.message}`);

  const total = count ?? 0;

  return { count: total, overdue: total, nextDueAt: oldest?.failed_at ?? null };
}

/** Spec §7's Reports module is not built; the count is, because an unread abuse
 *  report is exactly the thing this screen exists to stop being invisible. */
async function countReports(supabase: ServerSupabaseClient): Promise<Tally> {
  const [{ count, error }, { data: oldest }] = await Promise.all([
    supabase
      .from("reports")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "reviewing"]),
    supabase
      .from("reports")
      .select("created_at")
      .in("status", ["open", "reviewing"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) throw new Error(`Could not count reports: ${error.message}`);

  const total = count ?? 0;

  return { count: total, overdue: total, nextDueAt: oldest?.created_at ?? null };
}
