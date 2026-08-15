/**
 * Server-side reads for the delivery screens — spec §5 "Reviewing delivery" and
 * spec §6 "Delivery".
 *
 * Every query here runs under the caller's own Supabase client, so RLS is what
 * scopes it: `deliveries are visible to both sides` (migration 0008) returns
 * nothing at all to anyone who is not the client, the assigned worker or an
 * admin. The explicit `job_id` filters make the intent readable; they are not
 * what enforces it.
 *
 * The one exception is `files`, and it is the same exception the shortlist has.
 * No policy hands a client another user's `files` row — 0004 calls access to a
 * file "a decision, not a row predicate" — so the *names and sizes* of a
 * delivery are read with the service-role key, for exactly the file ids the
 * caller's own RLS-scoped query on `delivery_files` already returned. The
 * decision is made by the query above it; this only carries it out.
 */

import { DELIVERY_PREFIX, FREE_REVISIONS } from "@/lib/constants/deliveries";
import { DEFAULT_MAX_DELIVERY_BYTES } from "@/lib/constants/deliveries";
import { deliveryFileAccess } from "@/lib/deliveries/access";
import type {
  DeliveryAttempt,
  DeliveryReview,
  RevisionRecord,
  StagedFile,
  WorkerJobSummary,
  WorkerJobWork,
} from "@/lib/deliveries/types";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const DELIVERY_COLUMNS =
  "id, attempt, status, note, delivered_at, auto_accept_at, accepted_at, auto_accepted";

type FileFacts = {
  name: string;
  mimeType: string;
  sizeBytes: number;
  hasPreview: boolean;
};

/**
 * `files` rows for ids that have already survived an RLS-scoped read of
 * `delivery_files`. Never call this with ids from a request payload.
 */
async function loadFileFacts(fileIds: string[]): Promise<Map<string, FileFacts>> {
  const facts = new Map<string, FileFacts>();
  if (fileIds.length === 0) return facts;

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .from("files")
    .select("id, original_name, mime_type, size_bytes, preview_key")
    .in("id", [...new Set(fileIds)]);

  if (error) {
    // A screen that lists attempts, notes and the clock is still worth
    // rendering without its file names.
    console.error(`[deliveries] could not read file records: ${error.message}`);
    return facts;
  }

  for (const file of data ?? []) {
    facts.set(file.id, {
      name: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      hasPreview: file.preview_key !== null,
    });
  }

  return facts;
}

/**
 * Every attempt on a job, newest first, with each file's access already worked
 * out. Self-guarding: a caller who is not a participant gets an empty list from
 * the policy, not a filtered one from us.
 */
async function loadAttempts(
  supabase: ServerSupabaseClient,
  jobId: string,
): Promise<DeliveryAttempt[]> {
  const { data: deliveries, error } = await supabase
    .from("job_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("job_id", jobId)
    .order("attempt", { ascending: false });

  if (error) throw new Error(`Could not load deliveries for ${jobId}: ${error.message}`);
  if ((deliveries ?? []).length === 0) return [];

  const deliveryIds = (deliveries ?? []).map((delivery) => delivery.id);

  const { data: attached, error: filesError } = await supabase
    .from("delivery_files")
    .select("delivery_id, file_id, position, unlocked_at")
    .in("delivery_id", deliveryIds)
    .order("position");

  if (filesError) {
    throw new Error(`Could not load delivery files for ${jobId}: ${filesError.message}`);
  }

  const facts = await loadFileFacts((attached ?? []).map((row) => row.file_id));

  return (deliveries ?? []).map((delivery) => ({
    id: delivery.id,
    attempt: delivery.attempt,
    status: delivery.status,
    note: delivery.note,
    deliveredAt: delivery.delivered_at,
    autoAcceptAt: delivery.auto_accept_at,
    acceptedAt: delivery.accepted_at,
    autoAccepted: delivery.auto_accepted,
    files: (attached ?? [])
      .filter((row) => row.delivery_id === delivery.id)
      .flatMap((row) => {
        const fact = facts.get(row.file_id);
        if (!fact) return [];

        return [
          {
            fileId: row.file_id,
            name: fact.name,
            mimeType: fact.mimeType,
            sizeBytes: fact.sizeBytes,
            position: row.position,
            access: deliveryFileAccess({
              unlocked: row.unlocked_at !== null,
              mimeType: fact.mimeType,
              sizeBytes: fact.sizeBytes,
              hasPreview: fact.hasPreview,
            }),
          },
        ];
      }),
  }));
}

async function loadRevisions(
  supabase: ServerSupabaseClient,
  jobId: string,
): Promise<RevisionRecord[]> {
  const { data, error } = await supabase
    .from("job_revisions")
    .select("id, sequence, is_free, status, reason, created_at")
    .eq("job_id", jobId)
    .order("sequence");

  if (error) throw new Error(`Could not load revisions for ${jobId}: ${error.message}`);

  return (data ?? []).map((revision) => ({
    id: revision.id,
    sequence: revision.sequence,
    isFree: revision.is_free,
    status: revision.status,
    reason: revision.reason,
    createdAt: revision.created_at,
  }));
}

/** A first name, never the legal name on an ID — same rule as the shortlist. */
async function loadDisplayName(
  supabase: ServerSupabaseClient,
  profileId: string | null,
  fallback: string,
): Promise<string> {
  if (!profileId) return fallback;

  const { data } = await supabase
    .from("public_profiles")
    .select("display_name")
    .eq("profile_id", profileId)
    .maybeSingle();

  return data?.display_name ?? fallback;
}

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

/** `/worker/work`: everything this worker has been picked for. */
export async function loadWorkerJobs(
  supabase: ServerSupabaseClient,
  workerId: string,
  limit = 20,
): Promise<WorkerJobSummary[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, title, status, budget_paise, deadline_at, assigned_at, categories (name)")
    .eq("assigned_worker_id", workerId)
    .order("assigned_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load assigned jobs: ${error.message}`);

  const jobIds = (data ?? []).map((job) => job.id);
  const awaiting = new Map<string, { deliveredAt: string; autoAcceptAt: string }>();

  if (jobIds.length > 0) {
    const { data: pending, error: pendingError } = await supabase
      .from("job_deliveries")
      .select("job_id, delivered_at, auto_accept_at")
      .in("job_id", jobIds)
      .eq("status", "pending_review");

    if (pendingError) {
      throw new Error(`Could not load pending deliveries: ${pendingError.message}`);
    }

    for (const delivery of pending ?? []) {
      awaiting.set(delivery.job_id, {
        deliveredAt: delivery.delivered_at,
        autoAcceptAt: delivery.auto_accept_at,
      });
    }
  }

  return (data ?? []).flatMap((job) => {
    // `jobs_publishable` guarantees both past draft, and an assigned job is
    // well past it. The narrowing is for the type, not for the data.
    if (job.title === null || job.budget_paise === null) return [];

    const pending = awaiting.get(job.id);

    return [
      {
        jobId: job.id,
        title: job.title,
        status: job.status,
        budgetPaise: job.budget_paise,
        deadlineAt: job.deadline_at,
        categoryName: job.categories?.name ?? null,
        awaitingReviewSince: pending?.deliveredAt ?? null,
        autoAcceptAt: pending?.autoAcceptAt ?? null,
      },
    ];
  });
}

/** `/worker/work/[jobId]`: the brief, what has been sent, and what is staged. */
export async function loadWorkerJobWork(
  supabase: ServerSupabaseClient,
  workerId: string,
  jobId: string,
): Promise<WorkerJobWork | null> {
  // `assigned workers read their job` (0006) is what returns this. Someone
  // else's job comes back empty rather than forbidden.
  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, client_id, title, description, status, budget_paise, deadline_at, assigned_worker_id, categories (name, max_upload_bytes)",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!job || job.assigned_worker_id !== workerId) return null;
  if (job.title === null || job.description === null || job.budget_paise === null) return null;

  const [deliveries, revisions, clientName] = await Promise.all([
    loadAttempts(supabase, jobId),
    loadRevisions(supabase, jobId),
    loadDisplayName(supabase, job.client_id, "the client"),
  ]);

  const sent = new Set(
    deliveries.flatMap((delivery) => delivery.files.map((file) => file.fileId)),
  );

  // Registered against this job but never sent. The storage key is what ties a
  // file to a job before a `delivery_files` row exists — it is written by us,
  // pinned by the storage policy's owner segment, and re-checked at
  // registration.
  const { data: uploads, error: uploadsError } = await supabase
    .from("files")
    .select("id, original_name, mime_type, size_bytes, preview_key")
    .eq("owner_id", workerId)
    .eq("purpose", "delivery")
    .is("purged_at", null)
    .like("storage_key", `${DELIVERY_PREFIX}/${workerId}/${jobId}/%`)
    .order("created_at");

  if (uploadsError) {
    throw new Error(`Could not load staged files for ${jobId}: ${uploadsError.message}`);
  }

  const staged: StagedFile[] = (uploads ?? [])
    .filter((file) => !sent.has(file.id))
    .map((file) => ({
      fileId: file.id,
      name: file.original_name,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      hasPreview: file.preview_key !== null,
    }));

  const { data: earning, error: earningError } = await supabase
    .from("worker_earnings")
    .select(
      "status, gross_paise, commission_paise, tax_paise, net_paise, eligible_at, hold_until, hold_reason",
    )
    .eq("job_id", jobId)
    .maybeSingle();

  if (earningError) {
    throw new Error(`Could not load the earning for ${jobId}: ${earningError.message}`);
  }

  return {
    jobId: job.id,
    title: job.title,
    description: job.description,
    status: job.status,
    budgetPaise: job.budget_paise,
    deadlineAt: job.deadline_at,
    categoryName: job.categories?.name ?? null,
    maxUploadBytes: job.categories?.max_upload_bytes ?? DEFAULT_MAX_DELIVERY_BYTES,
    clientName,
    deliveries,
    revisions,
    staged,
    canDeliver: job.status === "assigned" || job.status === "revision_requested",
    earning: earning
      ? {
          status: earning.status,
          grossPaise: earning.gross_paise,
          commissionPaise: earning.commission_paise,
          taxPaise: earning.tax_paise,
          netPaise: earning.net_paise,
          eligibleAt: earning.eligible_at,
          holdUntil: earning.hold_until,
          holdReason: earning.hold_reason,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// The client's side
// ---------------------------------------------------------------------------

/** `/review/[jobId]`: what was delivered, and the two things they can do. */
export async function loadDeliveryReview(
  supabase: ServerSupabaseClient,
  jobId: string,
  clientId: string,
): Promise<DeliveryReview | null> {
  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, client_id, title, status, budget_paise, deadline_at, assigned_worker_id, categories (name)",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!job || job.client_id !== clientId) return null;
  if (job.title === null || job.budget_paise === null) return null;

  const [deliveries, revisions, workerName] = await Promise.all([
    loadAttempts(supabase, jobId),
    loadRevisions(supabase, jobId),
    loadDisplayName(supabase, job.assigned_worker_id, "the worker"),
  ]);

  const open = deliveries.find((delivery) => delivery.status === "pending_review");

  return {
    jobId: job.id,
    title: job.title,
    status: job.status,
    budgetPaise: job.budget_paise,
    deadlineAt: job.deadline_at,
    categoryName: job.categories?.name ?? null,
    workerName,
    deliveries,
    revisions,
    openDeliveryId: open?.id ?? null,
    // `request_job_revision()` reads `delivery.free_revisions` and is what
    // actually refuses. This is the same subtraction for the label.
    freeRevisionsLeft: Math.max(FREE_REVISIONS - revisions.length, 0),
  };
}
