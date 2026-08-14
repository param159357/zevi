"use server";

/**
 * Samples and the submission that puts them in front of a reviewer — spec §6.
 *
 * Rules that hold everywhere below:
 *   * the worker is re-derived from the session on every call, never taken from
 *     the payload, and the category is re-checked as one of theirs
 *   * nothing about an uploaded file is believed. Size and content type are read
 *     back from storage, not taken from the browser
 *   * "did you make this alone?" is stored, and a false answer is refused rather
 *     than saved. The stored `true` is what makes a later plagiarism ban
 *     defensible (spec §10)
 *   * submitting goes through `submit_worker_application()` with the
 *     service-role key: it counts the samples per category, starts the 24-hour
 *     SLA clock and moves the worker to 'pending_approval' in one transaction,
 *     and the direct UPDATE path is revoked precisely so a browser cannot post
 *     itself into the queue with three empty categories
 */

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/session";
import {
  ALLOWED_SAMPLE_MIME_TYPES,
  CAPTION_MAX_LENGTH,
  CAPTION_MIN_LENGTH,
  DEFAULT_MAX_SAMPLE_BYTES,
  SAMPLE_BUCKET,
  SAMPLE_PREFIX,
  SAMPLE_URL_TTL_SECONDS,
  WORKER_ROUTES,
} from "@/lib/constants/workers";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { formatBytes, formatDate } from "@/lib/utils/format";
import type {
  SampleResult,
  SampleUrlResult,
  SimpleResult,
  SubmitApplicationResult,
} from "@/lib/workers/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A trigger or CHECK that fires here is a bug in this file's validation, not
 * something the worker should read as prose — but they still need a sentence,
 * and the log still needs the original.
 */
function describeWriteError(error: { code?: string; message: string }): string {
  console.error(`[workers] write failed ${error.code ?? "?"}: ${error.message}`);

  if (error.message.includes("at most")) {
    return "That category is full. Remove a sample before adding another.";
  }
  if (error.code === "42501") {
    return "Your samples are locked while they're being reviewed.";
  }
  return "We couldn't save that. Try again.";
}

/** Freezes the portfolio the moment it is in review. Mirrors
 *  `worker_samples_locked()`, which is what actually refuses the write. */
async function samplesLocked(
  supabase: ServerSupabaseClient,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("worker_applications")
    .select("status")
    .eq("worker_id", workerId)
    .in("status", ["submitted", "approved", "approved_with_flag"])
    .limit(1);

  if (error) throw new Error(`Could not read the application: ${error.message}`);

  return (data ?? []).length > 0;
}

/** The category, if the worker actually works in it, with its own caps. */
async function loadOwnCategory(
  supabase: ServerSupabaseClient,
  workerId: string,
  categoryId: string,
): Promise<
  | { ok: true; sampleMax: number; maxUploadBytes: number }
  | { ok: false; error: string }
> {
  if (!UUID_PATTERN.test(categoryId)) {
    return { ok: false, error: "That category isn't one of yours." };
  }

  const { data, error } = await supabase
    .from("worker_categories")
    .select("categories (sample_max, max_upload_bytes)")
    .eq("worker_id", workerId)
    .eq("category_id", categoryId)
    .maybeSingle();

  if (error) throw new Error(`Could not load category ${categoryId}: ${error.message}`);
  if (!data?.categories) return { ok: false, error: "That category isn't one of yours." };

  return {
    ok: true,
    sampleMax: data.categories.sample_max,
    maxUploadBytes: data.categories.max_upload_bytes ?? DEFAULT_MAX_SAMPLE_BYTES,
  };
}

function parseCaption(input: string): { ok: true; value: string } | { ok: false; error: string } {
  // Rendered back to a reviewer and, once approved, to clients. Control
  // characters come out before length is judged.
  const value = input.replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();

  if (value.length < CAPTION_MIN_LENGTH) {
    return { ok: false, error: "Say what it was and what you did — one line." };
  }
  if (value.length > CAPTION_MAX_LENGTH) {
    return { ok: false, error: `Keep it under ${CAPTION_MAX_LENGTH} characters.` };
  }

  return { ok: true, value };
}

/** Deletes the stored object and marks the `files` row purged, keeping the
 *  evidence columns spec §12 requires. */
async function purgeObject(fileId: string, storageKey: string): Promise<void> {
  const admin = createServiceRoleClient();

  const { error: removeError } = await admin.storage.from(SAMPLE_BUCKET).remove([storageKey]);

  // A missing object is the state we wanted; anything else is worth knowing
  // about, but not worth failing the worker's action over.
  if (removeError) {
    console.error(`[workers] could not remove ${storageKey}: ${removeError.message}`);
  }

  const { error } = await admin
    .from("files")
    .update({ purged_at: new Date().toISOString(), retention_reason: "sample removed" })
    .eq("id", fileId)
    .is("purged_at", null);

  if (error) console.error(`[workers] could not mark file ${fileId} purged: ${error.message}`);
}

/** An object that never became a `files` row: nothing to keep, so it just goes. */
async function purgeUnregistered(storageKey: string): Promise<void> {
  const admin = createServiceRoleClient();
  const { error } = await admin.storage.from(SAMPLE_BUCKET).remove([storageKey]);
  if (error) console.error(`[workers] could not remove ${storageKey}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

export async function registerWorkerSample(input: {
  categoryId: string;
  storageKey: string;
  originalName: string;
  sha256: string;
  caption: string;
  soleAuthor: boolean;
}): Promise<SampleResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  const caption = parseCaption(input.caption);
  if (!caption.ok) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: caption.error, fieldErrors: { caption: caption.error } };
  }

  // Refused rather than stored as false: the checkbox is the claim the ban
  // rests on, and a sample nobody claimed is worth nothing to a reviewer.
  if (!input.soleAuthor) {
    const error = "Confirm you made this yourself before adding it.";
    await purgeUnregistered(input.storageKey);
    return { ok: false, error, fieldErrors: { soleAuthor: error } };
  }

  if (await samplesLocked(supabase, context.user.id)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "Your samples are locked while they're being reviewed." };
  }

  const category = await loadOwnCategory(supabase, context.user.id, input.categoryId);
  if (!category.ok) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: category.error };
  }

  const expectedPrefix = `${SAMPLE_PREFIX}/${context.user.id}/${input.categoryId}/`;
  const leaf = input.storageKey.startsWith(expectedPrefix)
    ? input.storageKey.slice(expectedPrefix.length)
    : null;

  // The storage policy already pins the owner segment; this pins the category
  // too, so one upload cannot be counted towards two of them.
  if (!leaf || leaf.length === 0 || leaf.includes("/") || leaf.includes("..")) {
    return { ok: false, error: "That upload didn't land where we expected." };
  }

  if (!SHA256_PATTERN.test(input.sha256)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "That upload couldn't be checksummed. Try again." };
  }

  const { data: existing, error: countError } = await supabase
    .from("worker_samples")
    .select("id, status")
    .eq("worker_id", context.user.id)
    .eq("category_id", input.categoryId);

  if (countError) throw new Error(`Could not count samples: ${countError.message}`);

  // The ceiling counts what the trigger counts: a rejected sample frees a slot.
  const live = (existing ?? []).filter((sample) => sample.status !== "rejected").length;

  if (live >= category.sampleMax) {
    await purgeUnregistered(input.storageKey);
    return {
      ok: false,
      error: `${category.sampleMax} samples is the most this category takes.`,
    };
  }

  const { data: info, error: infoError } = await supabase.storage
    .from(SAMPLE_BUCKET)
    .info(input.storageKey);

  if (infoError || !info) {
    return { ok: false, error: "We couldn't find that upload. Try adding it again." };
  }

  const sizeBytes = info.size ?? 0;
  const mimeType = info.contentType ?? "application/octet-stream";

  if (sizeBytes <= 0 || sizeBytes > category.maxUploadBytes) {
    await purgeUnregistered(input.storageKey);
    return {
      ok: false,
      error: `Samples in this category top out at ${formatBytes(category.maxUploadBytes)}.`,
    };
  }

  if (!(ALLOWED_SAMPLE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "We don't accept that kind of file as a sample." };
  }

  const originalName = input.originalName.replace(/\p{C}/gu, "").slice(0, 255).trim();

  const { data: file, error: fileError } = await supabase
    .from("files")
    .insert({
      owner_id: context.user.id,
      purpose: "sample",
      bucket: SAMPLE_BUCKET,
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
    // submit rather than anything the worker needs to fix twice.
    if (fileError.code === "23505") {
      return { ok: false, error: "That file is already one of your samples." };
    }
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: describeWriteError(fileError) };
  }

  // `position` orders the panel, so it counts every row including rejected ones
  // — reusing a number would put two samples in the same slot.
  const { data: sample, error: sampleError } = await supabase
    .from("worker_samples")
    .insert({
      worker_id: context.user.id,
      category_id: input.categoryId,
      file_id: file.id,
      caption: caption.value,
      sole_author_confirmed: true,
      position: (existing ?? []).length,
    })
    .select("id, position")
    .single();

  if (sampleError) {
    await purgeObject(file.id, input.storageKey);
    return { ok: false, error: describeWriteError(sampleError) };
  }

  revalidatePath(WORKER_ROUTES.samples);

  return {
    ok: true,
    sample: {
      id: sample.id,
      categoryId: input.categoryId,
      fileId: file.id,
      name: originalName || leaf,
      mimeType,
      sizeBytes,
      caption: caption.value,
      status: "pending",
      rejectionReason: null,
      position: sample.position,
    },
  };
}

export async function removeWorkerSample(sampleId: string): Promise<SimpleResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(sampleId)) return { ok: false, error: "That sample doesn't exist." };

  if (await samplesLocked(supabase, context.user.id)) {
    return { ok: false, error: "Your samples are locked while they're being reviewed." };
  }

  const { data: sample, error: lookupError } = await supabase
    .from("worker_samples")
    .select("id, worker_id, file_id, files (storage_key, owner_id)")
    .eq("id", sampleId)
    .maybeSingle();

  if (lookupError) throw new Error(`Could not load sample ${sampleId}: ${lookupError.message}`);
  if (!sample || sample.worker_id !== context.user.id || !sample.files) {
    return { ok: false, error: "That sample doesn't exist." };
  }

  const { error } = await supabase.from("worker_samples").delete().eq("id", sampleId);
  if (error) return { ok: false, error: describeWriteError(error) };

  await purgeObject(sample.file_id, sample.files.storage_key);

  revalidatePath(WORKER_ROUTES.samples);
  return { ok: true };
}

/** A short-lived link so a worker can check what they uploaded. */
export async function createSampleUrl(sampleId: string): Promise<SampleUrlResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(sampleId)) return { ok: false, error: "That sample doesn't exist." };

  const { data, error } = await supabase
    .from("worker_samples")
    .select("worker_id, files (storage_key)")
    .eq("id", sampleId)
    .maybeSingle();

  if (error) throw new Error(`Could not load sample ${sampleId}: ${error.message}`);
  if (!data?.files || data.worker_id !== context.user.id) {
    return { ok: false, error: "That sample doesn't exist." };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(SAMPLE_BUCKET)
    .createSignedUrl(data.files.storage_key, SAMPLE_URL_TTL_SECONDS);

  if (signError || !signed) {
    console.error(`[workers] could not sign ${sampleId}: ${signError?.message}`);
    return { ok: false, error: "We couldn't open that file. Try again." };
  }

  return { ok: true, url: signed.signedUrl };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export async function submitWorkerApplication(): Promise<SubmitApplicationResult> {
  const context = await requireRole("worker");

  const admin = createServiceRoleClient();
  const { data, error } = await admin
    .rpc("submit_worker_application", { p_worker_id: context.user.id })
    .single();

  if (error) {
    throw new Error(`submit_worker_application failed for ${context.user.id}: ${error.message}`);
  }

  switch (data.status) {
    case "submitted":
    // A second tab, or a double submit that beat the disabled button. It is in
    // the queue either way, so show them that rather than an error.
    case "already_submitted":
      break;
    case "already_approved":
      return { ok: false, error: "You're already approved — nothing left to submit." };
    case "no_categories":
      return { ok: false, error: "Choose at least one category first." };
    case "not_enough_samples":
      return {
        ok: false,
        error: data.detail
          ? `${data.detail} still needs more samples before you can submit.`
          : "One of your categories still needs more samples.",
      };
    case "resubmit_too_soon":
      return {
        ok: false,
        error: data.detail
          ? `You can resubmit from ${formatDate(data.detail)}.`
          : "It's too soon to resubmit.",
      };
    case "no_attempts_left":
      return {
        ok: false,
        error: "This account has used its one resubmission. Write to support.",
      };
    case "not_a_worker":
      return { ok: false, error: "This account isn't set up as a worker." };
    default:
      throw new Error(`submit_worker_application returned ${data.status}`);
  }

  revalidatePath(WORKER_ROUTES.samples);
  revalidatePath(WORKER_ROUTES.home);

  return { ok: true, slaDueAt: data.sla_due_at };
}
