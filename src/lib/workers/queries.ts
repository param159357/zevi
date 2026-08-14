/**
 * Server-side reads for the worker's onboarding surfaces.
 *
 * Every query runs under the caller's own Supabase client, so RLS is what
 * scopes it — `workers read their own samples` and `workers read their own
 * applications` in migration 0005. The explicit `worker_id` filters make the
 * intent readable; they are not what enforces it.
 */

import { DEFAULT_MAX_SAMPLE_BYTES } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import type {
  SampleCategory,
  SampleWorkspace,
  WorkerApplication,
  WorkerSample,
} from "@/lib/workers/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const APPLICATION_COLUMNS =
  "id, attempt, status, submitted_at, sla_due_at, reviewed_at, decision_reason, resubmit_after";

/**
 * The attempt in play. A worker has at most two (spec §6) and the newest is
 * always the one every screen is talking about.
 */
export async function loadLatestApplication(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<WorkerApplication | null> {
  const { data, error } = await supabase
    .from("worker_applications")
    .select(APPLICATION_COLUMNS)
    .eq("worker_id", workerId)
    .order("attempt", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not load the application: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    attempt: data.attempt,
    status: data.status,
    submittedAt: data.submitted_at,
    slaDueAt: data.sla_due_at,
    reviewedAt: data.reviewed_at,
    decisionReason: data.decision_reason,
    resubmitAfter: data.resubmit_after,
  };
}

export async function loadWorkerSamples(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<WorkerSample[]> {
  const { data, error } = await supabase
    .from("worker_samples")
    .select(
      "id, category_id, file_id, caption, status, rejection_reason, position, files (original_name, mime_type, size_bytes)",
    )
    .eq("worker_id", workerId)
    .order("category_id")
    .order("position");

  if (error) throw new Error(`Could not load samples: ${error.message}`);

  return (data ?? []).flatMap((sample) =>
    sample.files
      ? [
          {
            id: sample.id,
            categoryId: sample.category_id,
            fileId: sample.file_id,
            name: sample.files.original_name,
            mimeType: sample.files.mime_type,
            sizeBytes: sample.files.size_bytes,
            caption: sample.caption,
            status: sample.status,
            rejectionReason: sample.rejection_reason,
            position: sample.position,
          },
        ]
      : [],
  );
}

/** Counts what the 3-per-category floor counts: a rejected sample is not one. */
export function countsTowardMinimum(sample: WorkerSample): boolean {
  return sample.status !== "rejected";
}

/** Everything `/worker/samples` needs, in one place, in the order it renders. */
export async function loadSampleWorkspace(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<SampleWorkspace> {
  const [{ data: worker, error: workerError }, application, samples] = await Promise.all([
    supabase
      .from("worker_profiles")
      .select("status")
      .eq("profile_id", workerId)
      .maybeSingle(),
    loadLatestApplication(supabase, workerId),
    loadWorkerSamples(supabase, workerId),
  ]);

  if (workerError) {
    throw new Error(`Could not load the worker profile: ${workerError.message}`);
  }
  if (!worker) {
    throw new Error(
      `Signed-in worker ${workerId} has no worker_profiles row. Check ensureRoleRecord.`,
    );
  }

  const { data: links, error: linkError } = await supabase
    .from("worker_categories")
    .select(
      "category_id, categories (id, name, position, sample_format_note, sample_min, sample_max, max_upload_bytes)",
    )
    .eq("worker_id", workerId);

  if (linkError) throw new Error(`Could not load your categories: ${linkError.message}`);

  const categories: SampleCategory[] = (links ?? [])
    .flatMap((link) => (link.categories ? [link.categories] : []))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
    .map((category) => ({
      id: category.id,
      name: category.name,
      formatNote: category.sample_format_note,
      sampleMin: category.sample_min,
      sampleMax: category.sample_max,
      maxUploadBytes: category.max_upload_bytes ?? DEFAULT_MAX_SAMPLE_BYTES,
      samples: samples.filter((sample) => sample.categoryId === category.id),
    }));

  // Mirrors `worker_samples_locked()`, which is what actually refuses the write.
  const locked =
    application !== null &&
    ["submitted", "approved", "approved_with_flag"].includes(application.status);

  return {
    workerStatus: worker.status,
    application,
    categories,
    locked,
    readyToSubmit:
      categories.length > 0 &&
      categories.every(
        (category) =>
          category.samples.filter(countsTowardMinimum).length >= category.sampleMin,
      ),
  };
}
