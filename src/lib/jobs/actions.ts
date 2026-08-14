"use server";

/**
 * Posting a job — spec §5.
 *
 * Rules that hold everywhere below:
 *   * the client is re-derived from the session on every call, never taken from
 *     the payload, and the job is re-checked as theirs before anything is
 *     written. A form that only *shows* an editable job is not access control
 *   * a draft is validated leniently and a publish strictly, because "worth
 *     storing while they type" and "fit to show a worker" are different
 *     questions
 *   * publishing goes through `publish_job()` with the service-role key. It
 *     writes the moderation and classification queue rows in the same
 *     transaction as the status change, and those tables have INSERT revoked
 *     from `authenticated` exactly so a browser cannot decide it skipped review
 *   * nothing about an uploaded file is believed. Size and content type are
 *     read back from storage, not taken from the browser
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/session";
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  ATTACHMENT_BUCKET,
  ATTACHMENT_PREFIX,
  ATTACHMENT_URL_TTL_SECONDS,
  DEFAULT_MAX_UPLOAD_BYTES,
  DESCRIPTION_MAX_LENGTH,
  EDITABLE_JOB_STATUSES,
  JOB_ROUTES,
  MAX_ATTACHMENTS_PER_JOB,
  OTHER_CATEGORY_SLUG,
  TITLE_MAX_LENGTH,
} from "@/lib/constants/jobs";
import type {
  AttachmentResult,
  AttachmentUrlResult,
  FieldErrors,
  JobDraftInput,
  JobStatus,
  PublishJobResult,
  SaveDraftResult,
  SimpleResult,
} from "@/lib/jobs/types";
import {
  deadlineWindow,
  draftBudgetPaise,
  draftDeadline,
  draftText,
  endOfDayIst,
  parseBudgetPaise,
  parseDeadline,
  parseJobDescription,
  parseJobTitle,
} from "@/lib/jobs/validation";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { parseIpAddress } from "@/lib/utils/validation";
import { formatBytes } from "@/lib/utils/format";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const JOB_COLUMNS =
  "id, client_id, status, category_id, posted_as_other, title, description, budget_paise, deadline_at, published_at, updated_at";

type JobRow = {
  id: string;
  client_id: string;
  status: JobStatus;
  category_id: string | null;
  posted_as_other: boolean;
  title: string | null;
  description: string | null;
  budget_paise: number | null;
  deadline_at: string | null;
  published_at: string | null;
  updated_at: string;
};

function isEditable(status: JobStatus): boolean {
  return (EDITABLE_JOB_STATUSES as readonly string[]).includes(status);
}

/**
 * A trigger or CHECK that fires here is a bug in this file's validation, not
 * something the client should read as prose — but they still need a sentence,
 * and the log still needs the original.
 */
function describeWriteError(error: { code?: string; message: string }): string {
  console.error(`[jobs] write failed ${error.code ?? "?"}: ${error.message}`);

  if (error.message.includes("deadline exceeds")) {
    return "That deadline is longer than this budget allows. Shorten it or raise the budget.";
  }
  if (error.message.includes("locked once a worker is assigned")) {
    return "This job has a worker on it now, so the brief and the budget are fixed.";
  }
  return "We couldn't save that. Try again.";
}

/** The job, if it exists, belongs to this client and can still be changed. */
async function loadEditableJob(
  supabase: ServerSupabaseClient,
  jobId: string,
  clientId: string,
): Promise<{ job: JobRow } | { error: string }> {
  if (!UUID_PATTERN.test(jobId)) return { error: "That job doesn't exist." };

  const { data, error } = await supabase
    .from("jobs")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .maybeSingle<JobRow>();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  // RLS already scopes this to jobs the caller can see; the owner check is here
  // because "can see" also covers a worker reading the open feed.
  if (!data || data.client_id !== clientId) return { error: "That job doesn't exist." };

  if (!isEditable(data.status)) {
    return {
      error:
        data.status === "assigned" || data.status === "delivered"
          ? "A worker is on this job, so the brief is fixed now."
          : "This job can't be edited any more.",
    };
  }

  return { job: data };
}

/**
 * Resolves what the tiles were clicked into. "Other" is not a category a job
 * gets filed under — it is the absence of one, which `publish_job()` turns into
 * an admin queue entry (spec §5).
 */
async function resolveCategory(
  supabase: ServerSupabaseClient,
  categoryId: string | null,
  postedAsOther: boolean,
): Promise<
  | { ok: true; categoryId: string | null; postedAsOther: boolean; maxUploadBytes: number }
  | { ok: false; error: string }
> {
  if (postedAsOther || !categoryId) {
    return {
      ok: true,
      categoryId: null,
      postedAsOther,
      maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    };
  }

  if (!UUID_PATTERN.test(categoryId)) {
    return { ok: false, error: "Pick a category from the list." };
  }

  const { data, error } = await supabase
    .from("categories")
    .select("id, slug, max_upload_bytes")
    .eq("id", categoryId)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw new Error(`Could not load category ${categoryId}: ${error.message}`);
  if (!data) return { ok: false, error: "That category isn't available." };

  if (data.slug === OTHER_CATEGORY_SLUG) {
    return {
      ok: true,
      categoryId: null,
      postedAsOther: true,
      maxUploadBytes: data.max_upload_bytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    };
  }

  return {
    ok: true,
    categoryId: data.id,
    postedAsOther: false,
    maxUploadBytes: data.max_upload_bytes ?? DEFAULT_MAX_UPLOAD_BYTES,
  };
}

type JobWrite = {
  category_id: string | null;
  posted_as_other: boolean;
  title: string | null;
  description: string | null;
  budget_paise: number | null;
  deadline_at: string | null;
};

/**
 * Turns a form payload into a row.
 *
 * `strict` is on for a publish and for any edit of a job that is already live,
 * because a live job must satisfy `jobs_publishable` on every write. A draft
 * takes whatever is there.
 */
function buildWrite(
  input: JobDraftInput,
  category: { categoryId: string | null; postedAsOther: boolean },
  options: { strict: boolean; job: JobRow | null },
): { write: JobWrite } | { fieldErrors: FieldErrors } {
  if (!options.strict) {
    return {
      write: {
        category_id: category.categoryId,
        posted_as_other: category.postedAsOther,
        title: draftText(input.title, TITLE_MAX_LENGTH),
        description: draftText(input.description, DESCRIPTION_MAX_LENGTH),
        budget_paise: draftBudgetPaise(input.budget),
        deadline_at: draftDeadline(input.deadline),
      },
    };
  }

  const fieldErrors: FieldErrors = {};

  const title = parseJobTitle(input.title);
  if (!title.ok) fieldErrors.title = title.error;

  const description = parseJobDescription(input.description);
  if (!description.ok) fieldErrors.description = description.error;

  const budget = parseBudgetPaise(input.budget);
  if (!budget.ok) fieldErrors.budget = budget.error;

  if (!category.postedAsOther && !category.categoryId) {
    fieldErrors.categoryId = "Pick a category, or choose Other and we'll file it.";
  }

  let deadlineAt: string | null = null;

  if (budget.ok) {
    // A deadline that hasn't moved is always still legal: the cap is measured
    // from `published_at`, which hasn't moved either. Re-checking it would trap
    // a client editing the title of a job in its last days.
    const unchanged =
      options.job?.deadline_at != null &&
      input.deadline.length > 0 &&
      Date.parse(endOfDayIst(input.deadline)) === Date.parse(options.job.deadline_at);

    if (unchanged && options.job) {
      deadlineAt = options.job.deadline_at;
    } else {
      const parsed = parseDeadline(
        input.deadline,
        deadlineWindow({
          budgetPaise: budget.value,
          publishedAt: options.job?.published_at ?? null,
        }),
      );
      if (parsed.ok) deadlineAt = parsed.value;
      else fieldErrors.deadline = parsed.error;
    }
  } else if (!input.deadline) {
    fieldErrors.deadline = "Pick a deadline.";
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };

  return {
    write: {
      category_id: category.categoryId,
      posted_as_other: category.postedAsOther,
      title: title.ok ? title.value : null,
      description: description.ok ? description.value : null,
      budget_paise: budget.ok ? budget.value : null,
      deadline_at: deadlineAt,
    },
  };
}

async function persist(
  input: JobDraftInput,
  options: { strict: boolean },
): Promise<SaveDraftResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  let job: JobRow | null = null;

  if (input.jobId) {
    const found = await loadEditableJob(supabase, input.jobId, context.user.id);
    if ("error" in found) return { ok: false, error: found.error };
    job = found.job;
  }

  const category = await resolveCategory(
    supabase,
    input.categoryId,
    Boolean(input.postedAsOther),
  );
  if (!category.ok) return { ok: false, fieldErrors: { categoryId: category.error } };

  // A job that is already live has to stay publishable through every edit.
  const strict = options.strict || (job !== null && job.status !== "draft");

  const built = buildWrite(input, category, { strict, job });
  if ("fieldErrors" in built) return { ok: false, fieldErrors: built.fieldErrors };

  if (job) {
    const { error } = await supabase.from("jobs").update(built.write).eq("id", job.id);
    if (error) return { ok: false, error: describeWriteError(error) };

    return { ok: true, jobId: job.id, savedAt: new Date().toISOString() };
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({ ...built.write, client_id: context.user.id, status: "draft" })
    .select("id")
    .single();

  if (error) return { ok: false, error: describeWriteError(error) };

  return { ok: true, jobId: data.id, savedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * Autosave. Called on a debounce from the form, and again by hand before an
 * attachment needs a job to hang off.
 */
export async function saveJobDraft(input: JobDraftInput): Promise<SaveDraftResult> {
  return persist(input, { strict: false });
}

export async function discardJobDraft(jobId: string): Promise<SimpleResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  const found = await loadEditableJob(supabase, jobId, context.user.id);
  if ("error" in found) return { ok: false, error: found.error };
  if (found.job.status !== "draft") {
    return { ok: false, error: "This job is already live — cancel it instead." };
  }

  // The objects go; the `files` rows stay. Spec §12 keeps hash, name, size and
  // timestamp permanently, and a discarded draft is no exception.
  const { data: attached } = await supabase
    .from("job_attachments")
    .select("file_id, files (storage_key)")
    .eq("job_id", jobId);

  for (const row of attached ?? []) {
    if (row.files?.storage_key) await purgeObject(row.file_id, row.files.storage_key);
  }

  const { error } = await supabase.from("jobs").delete().eq("id", jobId);
  if (error) return { ok: false, error: describeWriteError(error) };

  revalidatePath(JOB_ROUTES.dashboard);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export async function publishJob(input: JobDraftInput): Promise<PublishJobResult> {
  const context = await requireRole("client");

  // Publish what is on screen, not what the last autosave happened to catch.
  const saved = await persist(input, { strict: true });
  if (!saved.ok) return { ok: false, error: saved.error, fieldErrors: saved.fieldErrors };

  const headerList = await headers();
  const postIp = parseIpAddress(
    headerList.get("x-forwarded-for") ?? headerList.get("x-real-ip"),
  );

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("publish_job", {
      p_job_id: saved.jobId,
      p_client_id: context.user.id,
      ...(postIp ? { p_ip: postIp } : {}),
    })
    .single();

  if (error) throw new Error(`publish_job failed for ${saved.jobId}: ${error.message}`);

  switch (data.status) {
    case "published":
    // A second tab, or a double submit that beat the disabled button. The job
    // is live either way, so show them that rather than an error.
    case "not_a_draft":
      break;
    case "incomplete":
      return { ok: false, error: "Something's still missing — check the fields above." };
    case "budget_out_of_range":
      return { ok: false, fieldErrors: { budget: "That budget is outside what we accept." } };
    case "deadline_out_of_range":
      return {
        ok: false,
        fieldErrors: { deadline: "That deadline is longer than this budget allows." },
      };
    case "not_found":
    case "forbidden":
      return { ok: false, error: "That job doesn't exist." };
    default:
      throw new Error(`publish_job returned ${data.status}`);
  }

  revalidatePath(JOB_ROUTES.dashboard);
  redirect(`${JOB_ROUTES.dashboard}?posted=${saved.jobId}`);
}

// ---------------------------------------------------------------------------
// Attachments
//
// The object is uploaded straight from the browser — a 500MB video has no
// business travelling through a Server Action — and this is where it becomes
// part of a job. Everything the browser claimed about it is re-read from
// storage first.
// ---------------------------------------------------------------------------

/** Deletes the stored object and marks the `files` row purged, keeping the
 *  evidence columns spec §12 requires. */
async function purgeObject(fileId: string, storageKey: string): Promise<void> {
  const admin = createServiceRoleClient();

  const { error: removeError } = await admin.storage
    .from(ATTACHMENT_BUCKET)
    .remove([storageKey]);

  // A missing object is the state we wanted; anything else is worth knowing
  // about, but not worth failing the client's action over.
  if (removeError) {
    console.error(`[jobs] could not remove ${storageKey}: ${removeError.message}`);
  }

  const { error } = await admin
    .from("files")
    .update({ purged_at: new Date().toISOString(), retention_reason: "attachment removed" })
    .eq("id", fileId)
    .is("purged_at", null);

  if (error) console.error(`[jobs] could not mark file ${fileId} purged: ${error.message}`);
}

export async function registerJobAttachment(input: {
  jobId: string;
  storageKey: string;
  originalName: string;
  sha256: string;
}): Promise<AttachmentResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  const found = await loadEditableJob(supabase, input.jobId, context.user.id);
  if ("error" in found) return { ok: false, error: found.error };

  const expectedPrefix = `${ATTACHMENT_PREFIX}/${context.user.id}/${input.jobId}/`;
  const leaf = input.storageKey.startsWith(expectedPrefix)
    ? input.storageKey.slice(expectedPrefix.length)
    : null;

  // The storage policy already pins the owner segment; this pins the job too,
  // so an object cannot be attached to a second job to dodge its retention.
  if (!leaf || leaf.length === 0 || leaf.includes("/") || leaf.includes("..")) {
    return { ok: false, error: "That upload didn't land where we expected." };
  }

  if (!SHA256_PATTERN.test(input.sha256)) {
    return { ok: false, error: "That upload couldn't be checksummed. Try again." };
  }

  const { count, error: countError } = await supabase
    .from("job_attachments")
    .select("file_id", { count: "exact", head: true })
    .eq("job_id", input.jobId);

  if (countError) throw new Error(`Could not count attachments: ${countError.message}`);

  const position = count ?? 0;
  if (position >= MAX_ATTACHMENTS_PER_JOB) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: `${MAX_ATTACHMENTS_PER_JOB} files is the limit on one job.` };
  }

  const { data: info, error: infoError } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .info(input.storageKey);

  if (infoError || !info) {
    return { ok: false, error: "We couldn't find that upload. Try adding it again." };
  }

  const sizeBytes = info.size ?? 0;
  const mimeType = info.contentType ?? "application/octet-stream";

  const category = await resolveCategory(
    supabase,
    found.job.category_id,
    found.job.posted_as_other,
  );
  const maxBytes = category.ok ? category.maxUploadBytes : DEFAULT_MAX_UPLOAD_BYTES;

  if (sizeBytes <= 0 || sizeBytes > maxBytes) {
    await purgeUnregistered(input.storageKey);
    return {
      ok: false,
      error: `Files for this category top out at ${formatBytes(maxBytes)}.`,
    };
  }

  if (!(ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "We don't accept that kind of file." };
  }

  const originalName = input.originalName
    // Kept forever as evidence (spec §12) and rendered back to both sides, so
    // control and other non-printing characters come out first.
    .replace(/\p{C}/gu, "")
    .slice(0, 255)
    .trim();

  const { data: file, error: fileError } = await supabase
    .from("files")
    .insert({
      owner_id: context.user.id,
      purpose: "job_attachment",
      bucket: ATTACHMENT_BUCKET,
      storage_key: input.storageKey,
      original_name: originalName || leaf,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      sha256: input.sha256,
    })
    .select("id")
    .single();

  if (fileError) {
    // 23505: this exact object is already registered, which means a double
    // submit rather than anything the client needs to fix twice.
    if (fileError.code === "23505") {
      return { ok: false, error: "That file is already attached." };
    }
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: describeWriteError(fileError) };
  }

  const { error: attachError } = await supabase
    .from("job_attachments")
    .insert({ job_id: input.jobId, file_id: file.id, position });

  if (attachError) {
    await purgeObject(file.id, input.storageKey);
    return { ok: false, error: describeWriteError(attachError) };
  }

  return {
    ok: true,
    attachment: { fileId: file.id, name: originalName || leaf, mimeType, sizeBytes },
  };
}

/** An object that never became a `files` row: nothing to keep, so it just goes. */
async function purgeUnregistered(storageKey: string): Promise<void> {
  const admin = createServiceRoleClient();
  const { error } = await admin.storage.from(ATTACHMENT_BUCKET).remove([storageKey]);
  if (error) console.error(`[jobs] could not remove ${storageKey}: ${error.message}`);
}

export async function removeJobAttachment(
  jobId: string,
  fileId: string,
): Promise<SimpleResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  const found = await loadEditableJob(supabase, jobId, context.user.id);
  if ("error" in found) return { ok: false, error: found.error };

  if (!UUID_PATTERN.test(fileId)) return { ok: false, error: "That file doesn't exist." };

  const { data: attachment, error: lookupError } = await supabase
    .from("job_attachments")
    .select("file_id, files (storage_key, owner_id)")
    .eq("job_id", jobId)
    .eq("file_id", fileId)
    .maybeSingle();

  if (lookupError) throw new Error(`Could not load attachment: ${lookupError.message}`);
  if (!attachment?.files || attachment.files.owner_id !== context.user.id) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { error } = await supabase
    .from("job_attachments")
    .delete()
    .eq("job_id", jobId)
    .eq("file_id", fileId);

  if (error) return { ok: false, error: describeWriteError(error) };

  await purgeObject(fileId, attachment.files.storage_key);

  return { ok: true };
}

/** A short-lived link so a client resuming a draft can check what they attached. */
export async function createAttachmentUrl(
  jobId: string,
  fileId: string,
): Promise<AttachmentUrlResult> {
  const context = await requireRole("client");
  const supabase = await createClient();

  const found = await loadEditableJob(supabase, jobId, context.user.id);
  if ("error" in found) return { ok: false, error: found.error };

  const { data, error } = await supabase
    .from("job_attachments")
    .select("files (storage_key, owner_id)")
    .eq("job_id", jobId)
    .eq("file_id", fileId)
    .maybeSingle();

  if (error) throw new Error(`Could not load attachment: ${error.message}`);
  if (!data?.files || data.files.owner_id !== context.user.id) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(data.files.storage_key, ATTACHMENT_URL_TTL_SECONDS);

  if (signError || !signed) {
    console.error(`[jobs] could not sign ${fileId}: ${signError?.message}`);
    return { ok: false, error: "We couldn't open that file. Try again." };
  }

  return { ok: true, url: signed.signedUrl };
}
