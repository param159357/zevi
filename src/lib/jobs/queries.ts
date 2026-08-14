/**
 * Server-side reads for the client's job surfaces.
 *
 * Every query here runs under the caller's own Supabase client, so RLS is what
 * scopes it — `clients read their own jobs` in migration 0006. The explicit
 * `client_id` filters are there to make the intent readable, not to enforce it.
 */

import { OTHER_CATEGORY_SLUG } from "@/lib/constants/jobs";
import type {
  EditableJob,
  JobAttachment,
  JobStatus,
  PostableCategory,
} from "@/lib/jobs/types";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The tiles. "Other" is excluded because it is not a category a job is filed
 * under — the form offers it separately, and picking it means `posted_as_other`
 * with no category at all (spec §5).
 */
export async function loadPostableCategories(
  supabase: ServerSupabaseClient,
): Promise<PostableCategory[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, slug, name, description, max_upload_bytes")
    .eq("status", "active")
    .order("position");

  if (error) throw new Error(`Could not load categories: ${error.message}`);

  return (data ?? [])
    .filter((category) => category.slug !== OTHER_CATEGORY_SLUG)
    .map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      maxUploadBytes: category.max_upload_bytes,
    }));
}

export async function loadJobForEditing(
  supabase: ServerSupabaseClient,
  jobId: string,
  clientId: string,
): Promise<{ job: EditableJob; attachments: JobAttachment[] } | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, client_id, status, category_id, posted_as_other, title, description, budget_paise, deadline_at, published_at, updated_at",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!data || data.client_id !== clientId) return null;

  const { data: attached, error: attachmentError } = await supabase
    .from("job_attachments")
    .select("file_id, position, files (id, original_name, mime_type, size_bytes)")
    .eq("job_id", jobId)
    .order("position");

  if (attachmentError) {
    throw new Error(`Could not load attachments for ${jobId}: ${attachmentError.message}`);
  }

  return {
    job: {
      id: data.id,
      status: data.status,
      categoryId: data.category_id,
      postedAsOther: data.posted_as_other,
      title: data.title ?? "",
      description: data.description ?? "",
      budgetPaise: data.budget_paise,
      deadlineAt: data.deadline_at,
      publishedAt: data.published_at,
      updatedAt: data.updated_at,
    },
    attachments: (attached ?? []).flatMap((row) =>
      row.files
        ? [
            {
              fileId: row.files.id,
              name: row.files.original_name,
              mimeType: row.files.mime_type,
              sizeBytes: row.files.size_bytes,
            },
          ]
        : [],
    ),
  };
}

export type ClientJobSummary = {
  id: string;
  title: string | null;
  status: JobStatus;
  budgetPaise: number | null;
  deadlineAt: string | null;
  updatedAt: string;
  optInCount: number;
  categoryName: string | null;
  postedAsOther: boolean;
};

/** The dashboard list. Drafts first — they are the ones needing a decision. */
export async function loadClientJobs(
  supabase: ServerSupabaseClient,
  clientId: string,
  limit = 20,
): Promise<ClientJobSummary[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id, title, status, budget_paise, deadline_at, updated_at, opt_in_count, posted_as_other, categories (name)",
    )
    .eq("client_id", clientId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load jobs: ${error.message}`);

  return (data ?? []).map((job) => ({
    id: job.id,
    title: job.title,
    status: job.status,
    budgetPaise: job.budget_paise,
    deadlineAt: job.deadline_at,
    updatedAt: job.updated_at,
    optInCount: job.opt_in_count,
    categoryName: job.categories?.name ?? null,
    postedAsOther: job.posted_as_other,
  }));
}
