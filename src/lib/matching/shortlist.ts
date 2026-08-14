/**
 * The client's half of matching: who opted into my job, and what have they made
 * before? Spec §5.
 *
 * Spec §5 describes five slots — one highest-rated, three AI-ranked, one newest
 * — and spec §16 cuts the ranking from V1 in one line: "AI ranking of middle 3
 * → show all opted-in workers sorted by rating". So there is no slot machinery
 * here and nothing is written to `job_shortlists`: that table records *which
 * five a client was shown and why*, which is evidence worth keeping the day
 * there is a ranking to record and noise before it.
 *
 * What scopes each read:
 *   * `clients read opt-ins on their own jobs` (0007) returns the opt-ins. The
 *     `job_id` filter is for the index and for readability
 *   * `approved workers are publicly visible`, `public identities are readable
 *     by signed-in users`, `category stats are public` and `approved samples
 *     are public` return the worker's half. Every one of those tables exists so
 *     that this screen never has to touch `profiles`, and none of this is
 *     trimmed from a wider SELECT
 *   * `files` is the exception: no policy shows a client another user's file
 *     row, deliberately. The storage key is read with the service-role key and
 *     signed, *after* the job has been confirmed as this client's — the same
 *     arrangement the approval queue uses, and the reason it is a decision made
 *     here rather than a policy on the table
 */

import {
  SHORTLIST_PAGE_SIZE,
  SHORTLIST_URL_TTL_SECONDS,
} from "@/lib/constants/matching";
import { SAMPLE_BUCKET } from "@/lib/constants/workers";
import type {
  OptInStatus,
  Shortlist,
  ShortlistSample,
  ShortlistWorker,
  WorkerRating,
} from "@/lib/matching/types";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { signStorageObjects } from "@/lib/uploads/sign";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which opt-ins the client sees. Everything but the ones that left: a withdrawn
 * opt-in is a worker who changed their mind, and an expired one belongs to a
 * job nobody took. `not_selected` stays because after the pick this list is the
 * record of the decision — who was there, and who was passed over.
 */
const VISIBLE_OPT_IN_STATUSES: OptInStatus[] = [
  "active",
  "shortlisted",
  "selected",
  "not_selected",
];

/** Live opt-ins, in the order `claim_job_assignment` will find them. */
export const PICKABLE_OPT_IN_STATUSES: OptInStatus[] = ["active", "shortlisted"];

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * V1's whole ranking, spec §16: rating, best first.
 *
 * Two tiebreaks under it, both deliberate. Jobs completed comes next because at
 * launch every rating is null and a list in random order is worse than one that
 * puts proven workers first. Then the opt-in's own timestamp — earliest first,
 * so a worker who read the brief and answered within the hour is not shuffled
 * below someone who arrived on day three with the same numbers.
 *
 * A selected worker sorts to the top regardless: once the job is assigned, the
 * person doing it is not a row in a comparison any more.
 */
function compareWorkers(a: ShortlistWorker, b: ShortlistWorker): number {
  if ((a.status === "selected") !== (b.status === "selected")) {
    return a.status === "selected" ? -1 : 1;
  }

  // Unrated sorts last rather than as a zero: "nobody has rated them" is not
  // the same claim as "they rate badly", and the card says which it is.
  const ratingA = a.rating.rating ?? -1;
  const ratingB = b.rating.rating ?? -1;
  if (ratingA !== ratingB) return ratingB - ratingA;

  if (a.totalJobsCompleted !== b.totalJobsCompleted) {
    return b.totalJobsCompleted - a.totalJobsCompleted;
  }

  return Date.parse(a.optedInAt) - Date.parse(b.optedInAt);
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * Every worker's approved samples in this job's category, signed for preview.
 *
 * Category-scoped on purpose: a client hiring for a deck is choosing between
 * decks, and a video reel in the middle of that comparison is noise. It is also
 * the only set the worker was approved in for this category (spec §6), which is
 * what makes it fair to judge them on.
 *
 * Only `approved` samples exist here — that is the policy, not a filter this
 * adds — so nothing pending review is ever shown to a client.
 */
async function loadSamplesByWorker(
  supabase: ServerSupabaseClient,
  workerIds: string[],
  categoryId: string,
): Promise<Map<string, ShortlistSample[]>> {
  const byWorker = new Map<string, ShortlistSample[]>();
  if (workerIds.length === 0) return byWorker;

  const { data, error } = await supabase
    .from("worker_samples")
    .select("id, worker_id, file_id, caption, position")
    .in("worker_id", workerIds)
    .eq("category_id", categoryId)
    .eq("status", "approved")
    .order("worker_id")
    .order("position");

  if (error) throw new Error(`Could not load samples: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return byWorker;

  // The file rows behind those samples. No policy hands a client another user's
  // `files` row, so this is the service-role read the module docstring
  // describes — narrowed to exactly the ids the client's own query returned,
  // which RLS has already scoped to samples that are approved and public.
  const admin = createServiceRoleClient();
  const { data: files, error: fileError } = await admin
    .from("files")
    .select("id, storage_key, original_name, mime_type, size_bytes, purged_at")
    .in(
      "id",
      rows.map((sample) => sample.file_id),
    );

  if (fileError) throw new Error(`Could not load sample files: ${fileError.message}`);

  const live = new Map(
    (files ?? [])
      .filter((file) => file.purged_at === null)
      .map((file) => [file.id, file]),
  );

  const signed = await signStorageObjects(
    SAMPLE_BUCKET,
    [...live.values()].map((file) => file.storage_key),
    SHORTLIST_URL_TTL_SECONDS,
  );

  for (const sample of rows) {
    const file = live.get(sample.file_id);
    // A purged file is a sample whose object is gone (spec §12 keeps the row,
    // not the bytes). Nothing to show, so it is not listed as an empty frame.
    if (!file) continue;

    const existing = byWorker.get(sample.worker_id) ?? [];
    existing.push({
      id: sample.id,
      caption: sample.caption,
      name: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      previewUrl: signed.get(file.storage_key) ?? null,
    });
    byWorker.set(sample.worker_id, existing);
  }

  return byWorker;
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

/**
 * Spec §6: ratings are category-specific, and the job count is always shown
 * beside the number. So the category figure wins where there is one, and the
 * overall is the fallback — labelled either way, because "4.8 across everything
 * they do" and "4.8 at exactly this" are different things to know.
 */
function resolveRating(
  overall: { rating: number | null; rating_job_count: number; jobs_completed: number },
  inCategory: { rating: number | null; rating_count: number; jobs_completed: number } | undefined,
): WorkerRating {
  if (inCategory && inCategory.rating !== null) {
    return {
      rating: inCategory.rating,
      ratingCount: inCategory.rating_count,
      jobsCompleted: inCategory.jobs_completed,
      inCategory: true,
    };
  }

  return {
    rating: overall.rating,
    ratingCount: overall.rating_job_count,
    jobsCompleted: overall.jobs_completed,
    inCategory: false,
  };
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Everything `/shortlist/[jobId]` renders, or null when the job is not this
 * client's to see. RLS has already decided that by the time we get here — the
 * `client_id` check below is what turns "no rows" into a 404 rather than a
 * half-rendered page, and the guard the service-role read above stands behind.
 */
export async function loadShortlist(
  supabase: ServerSupabaseClient,
  jobId: string,
  clientId: string,
): Promise<Shortlist | null> {
  if (!UUID_PATTERN.test(jobId)) return null;

  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, client_id, title, status, budget_paise, deadline_at, category_id, posted_as_other, assigned_worker_id, categories (name)",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);

  // `jobs_publishable` guarantees a title and a budget on anything past draft;
  // both are nullable for the draft's sake, and a draft has no opt-ins to show.
  if (!job || job.client_id !== clientId || job.title === null || job.budget_paise === null) {
    return null;
  }

  const shortlist: Shortlist = {
    jobId: job.id,
    title: job.title,
    status: job.status,
    budgetPaise: job.budget_paise,
    deadlineAt: job.deadline_at,
    categoryId: job.category_id,
    categoryName: job.categories?.name ?? null,
    postedAsOther: job.posted_as_other,
    assignedWorkerId: job.assigned_worker_id,
    workers: [],
    truncated: false,
  };

  // One row past the page, so "there are more" is a fact rather than a guess.
  const { data: optIns, error: optInError } = await supabase
    .from("job_opt_ins")
    .select("id, worker_id, status, created_at, software, turnaround, noticed_detail")
    .eq("job_id", jobId)
    .in("status", VISIBLE_OPT_IN_STATUSES)
    .order("created_at", { ascending: true })
    .limit(SHORTLIST_PAGE_SIZE + 1);

  if (optInError) throw new Error(`Could not load opt-ins: ${optInError.message}`);

  const rows = optIns ?? [];
  const page = rows.slice(0, SHORTLIST_PAGE_SIZE);
  if (page.length === 0) return shortlist;

  const workerIds = [...new Set(page.map((optIn) => optIn.worker_id))];

  const [
    { data: profiles, error: profileError },
    { data: identities, error: identityError },
    { data: categoryStats, error: statsError },
    samples,
  ] = await Promise.all([
    supabase
      .from("worker_profiles")
      .select("profile_id, headline, rating, rating_job_count, jobs_completed, created_at")
      .in("profile_id", workerIds),
    supabase
      .from("public_profiles")
      .select("profile_id, display_name, member_since")
      .in("profile_id", workerIds),
    job.category_id
      ? supabase
          .from("worker_category_stats")
          .select("worker_id, rating, rating_count, jobs_completed")
          .in("worker_id", workerIds)
          .eq("category_id", job.category_id)
      : Promise.resolve({ data: [], error: null }),
    job.category_id
      ? loadSamplesByWorker(supabase, workerIds, job.category_id)
      : Promise.resolve(new Map<string, ShortlistSample[]>()),
  ]);

  if (profileError) throw new Error(`Could not load workers: ${profileError.message}`);
  if (identityError) throw new Error(`Could not load worker names: ${identityError.message}`);
  if (statsError) throw new Error(`Could not load category ratings: ${statsError.message}`);

  const profileById = new Map((profiles ?? []).map((row) => [row.profile_id, row]));
  const identityById = new Map((identities ?? []).map((row) => [row.profile_id, row]));
  const statsById = new Map((categoryStats ?? []).map((row) => [row.worker_id, row]));

  const workers: ShortlistWorker[] = page.flatMap((optIn) => {
    const profile = profileById.get(optIn.worker_id);

    // Only an approved worker can hold an opt-in, and `approved workers are
    // publicly visible` returns exactly those — so a miss here is a worker
    // suspended since they opted in. Dropping the row is right: the client
    // cannot pick them (`claim_job_assignment` re-checks eligibility), and a
    // card that fails on the button is worse than one that never appeared.
    if (!profile) return [];

    const identity = identityById.get(optIn.worker_id);

    return [
      {
        optInId: optIn.id,
        workerId: optIn.worker_id,
        displayName: identity?.display_name ?? "A worker",
        headline: profile.headline,
        status: optIn.status,
        optedInAt: optIn.created_at,
        software: optIn.software,
        turnaround: optIn.turnaround,
        noticed: optIn.noticed_detail,
        rating: resolveRating(profile, statsById.get(optIn.worker_id)),
        totalJobsCompleted: profile.jobs_completed,
        memberSince: identity?.member_since ?? profile.created_at,
        samples: samples.get(optIn.worker_id) ?? [],
      },
    ];
  });

  return {
    ...shortlist,
    workers: workers.sort(compareWorkers),
    truncated: rows.length > SHORTLIST_PAGE_SIZE,
  };
}
