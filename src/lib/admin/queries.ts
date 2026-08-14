/**
 * Server-side reads for the worker approval queue (spec §7).
 *
 * Every read runs under the reviewer's own client, so the `review_workers`
 * policies on `worker_applications`, `worker_samples`, `files` and `profiles`
 * are what scope them. The one exception is signing a sample for preview: the
 * storage policy is anchored on the object's owner, and a reviewer is not the
 * owner, so the URL is minted with the service-role key *after* `requireAdmin`
 * has run. That is the arrangement migration 0004 describes — access to a file
 * is a decision, not a row predicate.
 */

import {
  REVIEW_URL_TTL_SECONDS,
  SAMPLE_BUCKET,
  isImageSample,
  reverseImageSearchUrl,
} from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { signStorageObjects } from "@/lib/uploads/sign";
import type { ApplicationReview, ApprovalQueueRow, ReviewSample } from "@/lib/admin/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The queue, ordered by what is rotting first (spec §7). Backed by
 * `worker_applications_queue_idx`, which is partial on `status = 'submitted'`.
 */
export async function loadApprovalQueue(
  supabase: ServerSupabaseClient,
  limit = 50,
): Promise<ApprovalQueueRow[]> {
  const { data, error } = await supabase
    .from("worker_applications")
    .select(
      "id, worker_id, attempt, submitted_at, sla_due_at, worker_profiles (profiles (full_name))",
    )
    .eq("status", "submitted")
    .order("sla_due_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Could not load the approval queue: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const workerIds = rows.map((row) => row.worker_id);

  // Two small follow-ups rather than aggregates in the embed: the queue is
  // bounded by what one reviewer can work through in a day, and a count that
  // arrives as a nested array is harder to read than a lookup built here.
  const [{ data: links, error: linkError }, { data: samples, error: sampleError }] =
    await Promise.all([
      supabase
        .from("worker_categories")
        .select("worker_id, categories (name, position)")
        .in("worker_id", workerIds),
      supabase
        .from("worker_samples")
        .select("application_id")
        .in(
          "application_id",
          rows.map((row) => row.id),
        )
        .neq("status", "rejected"),
    ]);

  if (linkError) throw new Error(`Could not load worker categories: ${linkError.message}`);
  if (sampleError) throw new Error(`Could not count samples: ${sampleError.message}`);

  const categoryNames = new Map<string, { name: string; position: number }[]>();
  for (const link of links ?? []) {
    if (!link.categories) continue;
    const existing = categoryNames.get(link.worker_id) ?? [];
    existing.push({ name: link.categories.name, position: link.categories.position });
    categoryNames.set(link.worker_id, existing);
  }

  const sampleCounts = new Map<string, number>();
  for (const sample of samples ?? []) {
    if (!sample.application_id) continue;
    sampleCounts.set(sample.application_id, (sampleCounts.get(sample.application_id) ?? 0) + 1);
  }

  return rows.map((row) => ({
    applicationId: row.id,
    workerId: row.worker_id,
    workerName: row.worker_profiles?.profiles?.full_name ?? "Unnamed worker",
    attempt: row.attempt,
    submittedAt: row.submitted_at,
    slaDueAt: row.sla_due_at,
    categoryNames: (categoryNames.get(row.worker_id) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((category) => category.name),
    sampleCount: sampleCounts.get(row.id) ?? 0,
  }));
}

/** One application: the samples, their captions, and a link to search each
 *  image for elsewhere on the internet. */
export async function loadApplicationForReview(
  supabase: ServerSupabaseClient,
  applicationId: string,
): Promise<ApplicationReview | null> {
  if (!UUID_PATTERN.test(applicationId)) return null;

  const { data: application, error } = await supabase
    .from("worker_applications")
    .select(
      "id, worker_id, attempt, status, submitted_at, sla_due_at, reviewed_at, decision_reason, worker_profiles (status, created_at, profiles (full_name, email))",
    )
    .eq("id", applicationId)
    .maybeSingle();

  if (error) throw new Error(`Could not load application ${applicationId}: ${error.message}`);
  if (!application?.worker_profiles) return null;

  const [{ data: links, error: linkError }, { data: samples, error: sampleError }] =
    await Promise.all([
      supabase
        .from("worker_categories")
        .select(
          "categories (id, name, position, sample_min, sample_max, sample_format_note)",
        )
        .eq("worker_id", application.worker_id),
      supabase
        .from("worker_samples")
        .select(
          "id, category_id, caption, status, position, files (storage_key, original_name, mime_type, size_bytes, purged_at)",
        )
        .eq("application_id", applicationId)
        .order("category_id")
        .order("position"),
    ]);

  if (linkError) throw new Error(`Could not load worker categories: ${linkError.message}`);
  if (sampleError) throw new Error(`Could not load samples: ${sampleError.message}`);

  const rows = (samples ?? []).flatMap((sample) =>
    sample.files && sample.files.purged_at === null
      ? [{ ...sample, files: sample.files }]
      : [],
  );

  // Signed for someone who does not own the objects: the storage policy is
  // anchored on the owner and a reviewer is not it. `requireAdmin` has already
  // run in the page above, which is what makes this allowed.
  const signed = await signStorageObjects(
    SAMPLE_BUCKET,
    rows.map((sample) => sample.files.storage_key),
    REVIEW_URL_TTL_SECONDS,
  );

  const previews = new Map<string, ReviewSample>();
  for (const sample of rows) {
    const previewUrl = signed.get(sample.files.storage_key) ?? null;

    previews.set(sample.id, {
      id: sample.id,
      caption: sample.caption,
      name: sample.files.original_name,
      mimeType: sample.files.mime_type,
      sizeBytes: sample.files.size_bytes,
      status: sample.status,
      previewUrl,
      reverseSearchUrl:
        previewUrl && isImageSample(sample.files.mime_type)
          ? reverseImageSearchUrl(previewUrl)
          : null,
    });
  }

  const worker = application.worker_profiles;

  return {
    applicationId: application.id,
    workerId: application.worker_id,
    workerName: worker.profiles?.full_name ?? "Unnamed worker",
    workerEmail: worker.profiles?.email ?? "",
    workerStatus: worker.status,
    memberSince: worker.created_at,
    attempt: application.attempt,
    status: application.status,
    submittedAt: application.submitted_at,
    slaDueAt: application.sla_due_at,
    reviewedAt: application.reviewed_at,
    decisionReason: application.decision_reason,
    categories: (links ?? [])
      .flatMap((link) => (link.categories ? [link.categories] : []))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((category) => ({
        id: category.id,
        name: category.name,
        sampleMin: category.sample_min,
        sampleMax: category.sample_max,
        formatNote: category.sample_format_note,
        samples: rows
          .filter((sample) => sample.category_id === category.id)
          .flatMap((sample) => {
            const preview = previews.get(sample.id);
            return preview ? [preview] : [];
          }),
      })),
  };
}
