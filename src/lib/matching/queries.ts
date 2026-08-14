/**
 * Server-side reads for the worker's feed and their opt-ins — spec §6.
 *
 * Every query runs under the caller's own Supabase client, so RLS is what
 * scopes it. `approved workers read the open feed` (migration 0006) already
 * limits `jobs` to open rows in a category the worker works in, and only for a
 * worker who is approved and whose account is active; `workers read their own
 * opt-ins` (0007) does the same for `job_opt_ins`. The explicit filters below
 * make the intent readable and let Postgres use `jobs_feed_idx` — they are not
 * what enforces it.
 *
 * The client's side of a card comes from `client_profiles` and
 * `public_profiles`, the two tables whose whole purpose is to be readable by
 * someone else. Nothing here selects from `profiles`.
 */

import {
  DWELL_SECONDS,
  DWELL_SECONDS_SETTING,
  FEED_PAGE_SIZE,
  MAX_ACTIVE_OPT_INS,
  MAX_ACTIVE_OPT_INS_SETTING,
} from "@/lib/constants/matching";
import type {
  ActiveOptIn,
  FeedBrief,
  FeedCategory,
  FeedClient,
  FeedJob,
  OptInCapacity,
  WorkerFeed,
} from "@/lib/matching/types";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/** Statuses that occupy one of the five slots, exactly as
 *  `sync_opt_in_counters()` counts them. */
export const HELD_OPT_IN_STATUSES = ["active", "shortlisted"] as const;

const FEED_COLUMNS =
  "id, client_id, category_id, title, budget_paise, deadline_at, published_at, opt_in_count, categories (name)";

const UNKNOWN_CLIENT: FeedClient = {
  displayName: "A client",
  rating: null,
  jobsCompleted: 0,
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The two tunables the feed quotes. Both are `is_public`, so the worker's own
 * client can read them; the constants are the same fallback `setting_int()`
 * gives the triggers, so a missing row degrades to the documented default
 * rather than to zero.
 */
export async function loadMatchingSettings(
  supabase: ServerSupabaseClient,
): Promise<{ maxActiveOptIns: number; dwellSeconds: number }> {
  const { data, error } = await supabase
    .from("platform_settings")
    .select("key, value")
    .in("key", [MAX_ACTIVE_OPT_INS_SETTING, DWELL_SECONDS_SETTING]);

  // A settings read failing is not worth refusing a worker the feed over: the
  // database enforces both numbers regardless of what this returns.
  if (error) {
    console.error(`[matching] could not read settings: ${error.message}`);
  }

  function read(key: string, fallback: number): number {
    const raw = (data ?? []).find((row) => row.key === key)?.value;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  return {
    maxActiveOptIns: read(MAX_ACTIVE_OPT_INS_SETTING, MAX_ACTIVE_OPT_INS),
    dwellSeconds: read(DWELL_SECONDS_SETTING, DWELL_SECONDS),
  };
}

// ---------------------------------------------------------------------------
// Capacity — spec §6's five active opt-ins
// ---------------------------------------------------------------------------

/**
 * Read the same way `sync_opt_in_counters()` decides it: the worker's own
 * override if they have one, otherwise the platform setting. `used` comes from
 * `worker_profiles.active_opt_ins`, which that trigger recomputes on every
 * write rather than incrementing — so it is a count, not a running total that
 * can drift.
 */
export async function loadOptInCapacity(
  supabase: ServerSupabaseClient,
  workerId: string,
  maxActiveOptIns: number,
): Promise<OptInCapacity> {
  const [{ data: profile, error: profileError }, { data: state, error: stateError }] =
    await Promise.all([
      supabase
        .from("worker_profiles")
        .select("active_opt_ins")
        .eq("profile_id", workerId)
        .maybeSingle(),
      supabase
        .from("worker_state")
        .select("opt_in_limit_override")
        .eq("profile_id", workerId)
        .maybeSingle(),
    ]);

  if (profileError) {
    throw new Error(`Could not read your opt-in count: ${profileError.message}`);
  }
  if (stateError) throw new Error(`Could not read your worker state: ${stateError.message}`);

  const used = profile?.active_opt_ins ?? 0;
  const cap = state?.opt_in_limit_override ?? maxActiveOptIns;

  return { used, cap, atCap: used >= cap };
}

// ---------------------------------------------------------------------------
// The client's half of a card
// ---------------------------------------------------------------------------

/**
 * `jobs.client_id` points at `profiles`, not at `client_profiles`, so there is
 * no foreign key for PostgREST to embed along — and there should not be, since
 * `profiles` is the table no policy exposes to another user. Two explicit reads
 * of the two public projections instead, keyed by the ids already on screen.
 */
async function loadFeedClients(
  supabase: ServerSupabaseClient,
  clientIds: string[],
): Promise<Map<string, FeedClient>> {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) return new Map();

  const [{ data: stats, error: statsError }, { data: identities, error: identityError }] =
    await Promise.all([
      supabase
        .from("client_profiles")
        .select("profile_id, rating, jobs_completed")
        .in("profile_id", unique),
      supabase
        .from("public_profiles")
        .select("profile_id, display_name")
        .in("profile_id", unique),
    ]);

  if (statsError) throw new Error(`Could not load client ratings: ${statsError.message}`);
  if (identityError) {
    throw new Error(`Could not load client names: ${identityError.message}`);
  }

  const names = new Map((identities ?? []).map((row) => [row.profile_id, row.display_name]));

  return new Map(
    unique.map((id) => {
      const row = (stats ?? []).find((stat) => stat.profile_id === id);

      return [
        id,
        {
          displayName: names.get(id) ?? UNKNOWN_CLIENT.displayName,
          rating: row?.rating ?? null,
          jobsCompleted: row?.jobs_completed ?? 0,
        },
      ];
    }),
  );
}

/** Which of these jobs the worker has already opted into, so a card can say so
 *  rather than letting them find out from a unique-violation. */
async function loadOwnOptInJobIds(
  supabase: ServerSupabaseClient,
  workerId: string,
  jobIds: string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("job_opt_ins")
    .select("job_id")
    .eq("worker_id", workerId)
    .in("job_id", jobIds);

  if (error) throw new Error(`Could not read your opt-ins: ${error.message}`);

  return new Set((data ?? []).map((row) => row.job_id));
}

// ---------------------------------------------------------------------------
// The feed
// ---------------------------------------------------------------------------

/** The worker's up-to-three categories, with a live count for each tab. */
async function loadFeedCategories(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<{ categories: FeedCategory[]; categoryIds: string[] }> {
  const { data, error } = await supabase
    .from("worker_categories")
    .select("category_id, categories (id, name, position)")
    .eq("worker_id", workerId);

  if (error) throw new Error(`Could not load your categories: ${error.message}`);

  const rows = (data ?? [])
    .flatMap((link) => (link.categories ? [link.categories] : []))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return {
    categories: rows.map((category) => ({
      id: category.id,
      name: category.name,
      jobCount: 0,
    })),
    categoryIds: rows.map((category) => category.id),
  };
}

/**
 * Everything `/worker/jobs` renders. Newest first, spec §6.
 *
 * `activeCategoryId` narrows the query when it names one of the worker's own
 * categories and is ignored otherwise — a category they do not work in would
 * return nothing anyway (RLS), and silently showing an empty feed is a worse
 * answer than showing all of it.
 */
export async function loadWorkerFeed(
  supabase: ServerSupabaseClient,
  workerId: string,
  requestedCategoryId: string | null,
): Promise<WorkerFeed> {
  const [
    { data: worker, error: workerError },
    { categories, categoryIds },
    settings,
  ] = await Promise.all([
    supabase.from("worker_profiles").select("status").eq("profile_id", workerId).maybeSingle(),
    loadFeedCategories(supabase, workerId),
    loadMatchingSettings(supabase),
  ]);

  if (workerError) throw new Error(`Could not load your profile: ${workerError.message}`);
  if (!worker) {
    throw new Error(
      `Signed-in worker ${workerId} has no worker_profiles row. Check ensureRoleRecord.`,
    );
  }

  const capacity = await loadOptInCapacity(supabase, workerId, settings.maxActiveOptIns);
  const activeCategoryId =
    requestedCategoryId && categoryIds.includes(requestedCategoryId)
      ? requestedCategoryId
      : null;

  const empty: WorkerFeed = {
    workerStatus: worker.status,
    categories,
    activeCategoryId,
    jobs: [],
    truncated: false,
    capacity,
    dwellSeconds: settings.dwellSeconds,
  };

  // An unapproved worker sees no jobs by policy; skipping the query means the
  // page renders the "not yet" panel without a pointless round trip.
  const approved = worker.status === "approved" || worker.status === "approved_with_flag";
  if (!approved || categoryIds.length === 0) return empty;

  // One row past the page, so "there are more" is a fact rather than a guess.
  const { data, error } = await supabase
    .from("jobs")
    .select(FEED_COLUMNS)
    .eq("status", "open")
    .in("category_id", activeCategoryId ? [activeCategoryId] : categoryIds)
    .order("published_at", { ascending: false })
    .limit(FEED_PAGE_SIZE + 1);

  if (error) throw new Error(`Could not load the feed: ${error.message}`);

  const rows = data ?? [];
  const page = rows.slice(0, FEED_PAGE_SIZE);

  const [clients, ownOptIns] = await Promise.all([
    loadFeedClients(
      supabase,
      page.map((job) => job.client_id),
    ),
    loadOwnOptInJobIds(
      supabase,
      workerId,
      page.map((job) => job.id),
    ),
  ]);

  // `jobs_publishable` guarantees a title and a budget on anything that is not
  // a draft, but the columns are nullable for the draft's sake — so the feed
  // drops a row it cannot render rather than asserting with `!`.
  const jobs: FeedJob[] = page.flatMap((job) =>
    job.title !== null && job.budget_paise !== null
      ? [
          {
            id: job.id,
            title: job.title,
            categoryId: job.category_id,
            categoryName: job.categories?.name ?? null,
            budgetPaise: job.budget_paise,
            deadlineAt: job.deadline_at,
            publishedAt: job.published_at,
            optInCount: job.opt_in_count,
            client: clients.get(job.client_id) ?? UNKNOWN_CLIENT,
            optedIn: ownOptIns.has(job.id),
          },
        ]
      : [],
  );

  // Counted separately rather than tallied off the page above: the tabs
  // describe the whole board, and the page is one filter and one `limit` away
  // from it. Ids only, straight off `jobs_feed_idx`.
  const counts = await loadCategoryCounts(supabase, categoryIds);

  return {
    ...empty,
    jobs,
    truncated: rows.length > FEED_PAGE_SIZE,
    categories: categories.map((category) => ({
      ...category,
      jobCount: counts.get(category.id) ?? 0,
    })),
  };
}

/** Open jobs per category, for the filter tabs. */
async function loadCategoryCounts(
  supabase: ServerSupabaseClient,
  categoryIds: string[],
): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("jobs")
    .select("category_id")
    .eq("status", "open")
    .in("category_id", categoryIds);

  if (error) throw new Error(`Could not count open jobs: ${error.message}`);

  const counts = new Map<string, number>();

  for (const row of data ?? []) {
    if (row.category_id) counts.set(row.category_id, (counts.get(row.category_id) ?? 0) + 1);
  }

  return counts;
}

// ---------------------------------------------------------------------------
// One brief
// ---------------------------------------------------------------------------

/**
 * The brief a worker reads before opting in. Returns null when the job is not
 * theirs to see — which RLS has already decided by the time we get here, so
 * this is the difference between a 404 and a leak, not the check itself.
 *
 * A job they have already opted into stays readable after it leaves the feed
 * (`opted-in workers keep reading the job`, migration 0007), so the page has to
 * handle a status other than 'open'.
 */
export async function loadFeedBrief(
  supabase: ServerSupabaseClient,
  workerId: string,
  jobId: string,
): Promise<FeedBrief | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select(`${FEED_COLUMNS}, description, status, expires_at`)
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!data || data.title === null || data.budget_paise === null || data.description === null) {
    return null;
  }

  const [clients, ownOptIns] = await Promise.all([
    loadFeedClients(supabase, [data.client_id]),
    loadOwnOptInJobIds(supabase, workerId, [data.id]),
  ]);

  return {
    id: data.id,
    title: data.title,
    categoryId: data.category_id,
    categoryName: data.categories?.name ?? null,
    budgetPaise: data.budget_paise,
    deadlineAt: data.deadline_at,
    publishedAt: data.published_at,
    optInCount: data.opt_in_count,
    client: clients.get(data.client_id) ?? UNKNOWN_CLIENT,
    optedIn: ownOptIns.has(data.id),
    description: data.description,
    status: data.status,
    expiresAt: data.expires_at,
  };
}

// ---------------------------------------------------------------------------
// The five slots, as a list
// ---------------------------------------------------------------------------

/**
 * The opt-ins currently holding a slot, newest first. This is what makes the
 * cap legible: "five" means nothing without the five in front of you.
 */
export async function loadActiveOptIns(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<ActiveOptIn[]> {
  const { data, error } = await supabase
    .from("job_opt_ins")
    .select(
      "id, status, created_at, software, turnaround, noticed_detail, jobs (id, title, status, budget_paise, deadline_at, categories (name))",
    )
    .eq("worker_id", workerId)
    .in("status", HELD_OPT_IN_STATUSES)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Could not load your opt-ins: ${error.message}`);

  return (data ?? []).flatMap((row) =>
    row.jobs
      ? [
          {
            id: row.id,
            status: row.status,
            createdAt: row.created_at,
            software: row.software,
            turnaround: row.turnaround,
            noticed: row.noticed_detail,
            job: {
              id: row.jobs.id,
              title: row.jobs.title ?? "Untitled",
              status: row.jobs.status,
              categoryName: row.jobs.categories?.name ?? null,
              budgetPaise: row.jobs.budget_paise,
              deadlineAt: row.jobs.deadline_at,
            },
          },
        ]
      : [],
  );
}
