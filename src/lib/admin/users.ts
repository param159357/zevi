/**
 * Server-side reads for the Users module (spec §7).
 *
 * "Full history, ratings, disputes, cancellations, earnings, KYC. Warn ·
 * suspend · ban. Every action logged with reason."
 *
 * This is the one console screen that reads `profiles` — the PII table — and it
 * is allowed to because 0027 gives `manage_users` a policy on it. That is also
 * why every query here runs under the reviewer's own client rather than the
 * service-role one: a `finance` or `reviewer` account that wandered onto this
 * URL gets a 404 from `requireAdmin`, and if it somehow did not, it would get
 * empty rows from the policies. Two independent answers to the same question.
 *
 * `worker_state` and `user_private_stats` are admin-only *by table* rather than
 * by remembering to trim a SELECT list, which is the arrangement 0002 chose and
 * the reason the risk score and the dispute rate can be read here without
 * anyone auditing the column list on this file later.
 */

import { createClient } from "@/lib/supabase/server";
import type { UserDetail, UserJob, UserSanction, UserSearchRow } from "@/lib/admin/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PostgREST treats these as operators inside a filter value. */
function escapeFilterValue(term: string): string {
  return term.replace(/[%,()\\]/g, " ").trim();
}

/**
 * Find an account by name or email.
 *
 * Deliberately a search rather than a list: `profiles` is every user on the
 * platform, and a console screen that pages through all of them is a PII
 * browsing surface nobody asked for. An empty query returns the newest few, so
 * the screen has something on it and "who signed up today" stays one click away.
 */
export async function searchUsers(
  supabase: ServerSupabaseClient,
  term: string,
  limit = 25,
): Promise<UserSearchRow[]> {
  const cleaned = escapeFilterValue(term ?? "");

  let query = supabase
    .from("profiles")
    .select("id, full_name, email, status, is_client, is_worker, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (cleaned.length >= 2) {
    query = query.or(`full_name.ilike.%${cleaned}%,email.ilike.%${cleaned}%`);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Could not search users: ${error.message}`);

  return (data ?? []).map((row) => ({
    profileId: row.id,
    fullName: row.full_name,
    email: row.email,
    status: row.status,
    isClient: row.is_client,
    isWorker: row.is_worker,
    createdAt: row.created_at,
  }));
}

/**
 * One account, whole.
 *
 * The two role halves are loaded only for the roles the account actually holds
 * — `is_client` and `is_worker` are maintained by trigger, so they are reliable
 * — and the worker half is three more reads because earnings, KYC and private
 * state live in three tables with three different access rules.
 */
export async function loadUserDetail(
  supabase: ServerSupabaseClient,
  profileId: string,
): Promise<UserDetail | null> {
  if (!UUID_PATTERN.test(profileId)) return null;

  const { data: profile, error } = await supabase
    .from("profiles")
    .select(
      `id, full_name, display_name, email, mobile, email_verified_at, mobile_verified_at,
       status, status_reason, suspended_until, is_client, is_worker, created_at, last_seen_at`,
    )
    .eq("id", profileId)
    .maybeSingle();

  if (error) throw new Error(`Could not load user ${profileId}: ${error.message}`);
  if (!profile) return null;

  const [
    { data: clientProfile },
    { data: privateStats },
    { data: sanctions, error: sanctionError },
    { data: targetIsAdmin },
    jobs,
    worker,
  ] = await Promise.all([
    profile.is_client
      ? supabase
          .from("client_profiles")
          .select(
            "rating, rating_job_count, jobs_posted, jobs_completed, jobs_cancelled, total_spend_paise",
          )
          .eq("profile_id", profileId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("user_private_stats")
      .select(
        "disputes_raised, disputes_against, disputes_lost, dispute_rate_bps, chargebacks, reports_against, risk_score",
      )
      .eq("profile_id", profileId)
      .maybeSingle(),
    supabase
      .from("user_sanctions")
      .select("id, type, reason, internal_note, starts_at, ends_at, lifted_at, created_at")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(50),
    // Not a SELECT on `admin_users`: that table has RLS on and no policies at
    // all, deliberately, so a direct read comes back empty even for a super
    // admin and the screen would cheerfully offer to ban one. 0035 adds the
    // security-definer helper instead — the same shape as `is_active_worker`,
    // and it answers a boolean rather than handing out the membership list.
    supabase.rpc("is_admin_account", { p_profile_id: profileId }),
    loadUserJobs(supabase, profileId),
    profile.is_worker ? loadWorkerHalf(supabase, profileId) : Promise.resolve(null),
  ]);

  if (sanctionError) throw new Error(`Could not load sanctions: ${sanctionError.message}`);

  return {
    profileId: profile.id,
    fullName: profile.full_name,
    displayName: profile.display_name,
    email: profile.email,
    mobile: profile.mobile,
    emailVerifiedAt: profile.email_verified_at,
    mobileVerifiedAt: profile.mobile_verified_at,
    status: profile.status,
    statusReason: profile.status_reason,
    suspendedUntil: profile.suspended_until,
    isClient: profile.is_client,
    isWorker: profile.is_worker,
    createdAt: profile.created_at,
    lastSeenAt: profile.last_seen_at,
    isAdmin: targetIsAdmin === true,
    client: clientProfile
      ? {
          rating: clientProfile.rating,
          ratingCount: clientProfile.rating_job_count,
          jobsPosted: clientProfile.jobs_posted,
          jobsCompleted: clientProfile.jobs_completed,
          jobsCancelled: clientProfile.jobs_cancelled,
          totalSpendPaise: clientProfile.total_spend_paise,
        }
      : null,
    worker,
    privateStats: privateStats
      ? {
          disputesRaised: privateStats.disputes_raised,
          disputesAgainst: privateStats.disputes_against,
          disputesLost: privateStats.disputes_lost,
          disputeRateBps: privateStats.dispute_rate_bps,
          chargebacks: privateStats.chargebacks,
          reportsAgainst: privateStats.reports_against,
          riskScore: privateStats.risk_score,
        }
      : null,
    sanctions: (sanctions ?? []).map(
      (row): UserSanction => ({
        id: row.id,
        type: row.type,
        reason: row.reason,
        internalNote: row.internal_note,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        liftedAt: row.lifted_at,
        createdAt: row.created_at,
      }),
    ),
    jobs,
  };
}

/**
 * The worker half: profile, private state, KYC and what they have actually been
 * paid.
 *
 * Lifetime earnings are summed here rather than read from
 * `worker_state.lifetime_earnings_paise`, for the reason 0033 gives about the
 * same column: nothing on the platform maintains it, and a number on an admin
 * screen that is quietly always zero is worse than no number.
 */
async function loadWorkerHalf(supabase: ServerSupabaseClient, profileId: string) {
  const [{ data: workerProfile }, { data: state }, { data: kyc }, { data: earnings }] =
    await Promise.all([
      supabase
        .from("worker_profiles")
        .select("status, tier, rating, rating_job_count, jobs_completed, active_opt_ins")
        .eq("profile_id", profileId)
        .maybeSingle(),
      supabase
        .from("worker_state")
        .select("kyc_status, earnings_frozen, outstanding_debit_paise, jobs_abandoned")
        .eq("profile_id", profileId)
        .maybeSingle(),
      supabase
        .from("worker_kyc")
        .select("status")
        .eq("worker_id", profileId)
        .maybeSingle(),
      supabase.from("worker_earnings").select("status, net_paise").eq("worker_id", profileId),
    ]);

  if (!workerProfile) return null;

  let lifetime = 0;
  let paid = 0;
  let pending = 0;

  for (const earning of earnings ?? []) {
    if (earning.status === "reversed" || earning.status === "forfeited") continue;

    lifetime += earning.net_paise;
    if (earning.status === "paid") paid += earning.net_paise;
    else pending += earning.net_paise;
  }

  return {
    status: workerProfile.status,
    tier: workerProfile.tier,
    rating: workerProfile.rating,
    ratingCount: workerProfile.rating_job_count,
    jobsCompleted: workerProfile.jobs_completed,
    activeOptIns: workerProfile.active_opt_ins,
    // `worker_kyc` is the record of the identity check; `worker_state.kyc_status`
    // is the copy the rest of the platform reads. They should agree, and the
    // first is the one to believe if they ever do not.
    kycStatus: kyc?.status ?? state?.kyc_status ?? null,
    earningsFrozen: state?.earnings_frozen ?? false,
    outstandingDebitPaise: state?.outstanding_debit_paise ?? 0,
    jobsAbandoned: state?.jobs_abandoned ?? 0,
    lifetimeEarningsPaise: lifetime,
    paidPaise: paid,
    pendingPaise: pending,
  };
}

/** Both sides of their history, newest first. `admins read every job` is what
 *  returns rows here for either role. */
async function loadUserJobs(
  supabase: ServerSupabaseClient,
  profileId: string,
  limit = 25,
): Promise<UserJob[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, status, budget_paise, client_id, assigned_worker_id, created_at")
    .or(`client_id.eq.${profileId},assigned_worker_id.eq.${profileId}`)
    .neq("status", "draft")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load job history: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title?.trim() || "Untitled job",
    status: row.status,
    budgetPaise: row.budget_paise ?? 0,
    role: row.client_id === profileId ? ("client" as const) : ("worker" as const),
    createdAt: row.created_at,
  }));
}
