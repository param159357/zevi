"use server";

/**
 * Delivery, acceptance and the one free revision — spec §4 steps 7–9.
 *
 * Rules that hold everywhere below:
 *   * whoever is acting is re-derived from the session on every call, never
 *     taken from the payload. A form that renders is not authorisation
 *   * nothing about an uploaded file is believed. Size and content type are read
 *     back from storage, not taken from the browser — the same shape job
 *     attachments and worker samples use, and `lib/uploads/client.ts` is the
 *     half they all share
 *   * the four writes that matter go through migration 0030's functions with the
 *     service-role key. `job_deliveries`, `delivery_files` and `job_revisions`
 *     have INSERT revoked from `authenticated`, and acceptance moves money — so
 *     the database takes the row lock, re-checks the actor and does the whole
 *     thing in one transaction. The checks in this file exist to give a decent
 *     sentence before that, not to stand in for it
 *   * a clean file is never handed to a client before `unlocked_at`. There is
 *     one function that decides that (`deliveryFileAccess`) and one place that
 *     mints a URL from it (`openDeliveredFile`)
 *
 * Every export here is a URL the browser can post to, which is why the preview
 * generator, the storage purge and the file-facts read are all plain functions
 * further down rather than exports of their own.
 */

import { revalidatePath } from "next/cache";

import { requireRole, requireUser } from "@/lib/auth/session";
import {
  ALLOWED_DELIVERY_MIME_TYPES,
  DEFAULT_MAX_DELIVERY_BYTES,
  DELIVERY_BUCKET,
  DELIVERY_PREFIX,
  DELIVERY_PREVIEW_PREFIX,
  DELIVERY_URL_TTL_SECONDS,
  MAX_FILES_PER_DELIVERY,
  PREVIEW_MAX_SOURCE_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  previewKindFor,
} from "@/lib/constants/deliveries";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { deliveryFileAccess, describeLocked } from "@/lib/deliveries/access";
import { generatePreview, watermarkLabel } from "@/lib/deliveries/preview";
import type {
  OpenFileResult,
  RegisterFileResult,
  RevisionResult,
  SimpleResult,
  SubmitDeliveryResult,
} from "@/lib/deliveries/types";
import { parseDeliveryNote, parseRevisionReason } from "@/lib/deliveries/validation";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { formatBytes } from "@/lib/utils/format";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * A raise out of one of 0030's functions, as a sentence. Most of these are
 * reachable without a bug — a client who accepted in another tab, a sweep that
 * landed while the page was open, a worker who tried to send twice.
 */
function describeRpcError(
  error: { code?: string; message: string },
  context: string,
): string {
  console.error(`[deliveries] ${context} failed ${error.code ?? "?"}: ${error.message}`);

  if (error.message.includes("has no active assignment")) {
    return "This job doesn't have an active assignment any more.";
  }
  if (error.message.includes("only the assigned worker")) {
    return "This job isn't yours to deliver.";
  }
  if (error.message.includes("is not waiting on a delivery")) {
    return "This job isn't waiting on a delivery right now. Reload to see where it got to.";
  }
  if (error.message.includes("already been delivered on another job")) {
    return "One of those files has already been sent on a different job.";
  }
  if (error.message.includes("not one of this worker's delivery files")) {
    return "One of those files isn't yours to send. Reload and try again.";
  }
  if (error.message.includes("cannot be accepted")) {
    return "This delivery isn't open any more. Reload to see where it got to.";
  }
  if (error.message.includes("is not open for a revision")) {
    return "This delivery isn't open for a revision any more. Reload the page.";
  }
  if (error.message.includes("review window on delivery")) {
    return "The review window on this delivery has closed, so it counts as accepted.";
  }
  if (error.message.includes("used its free revision")) {
    return "You've used the free revision on this job. Accept the work, or contact support.";
  }
  if (error.message.includes("escrow on job") && error.message.includes("frozen")) {
    return "The money on this job is frozen while it's being looked into, so it can't be accepted yet.";
  }
  if (error.message.includes("nothing in escrow") || error.message.includes("no frozen price")) {
    return "We can't find the payment behind this job. We're on it — don't pay again.";
  }
  if (error.code === "42501" || error.message.includes("only the client")) {
    return "That job isn't yours.";
  }
  return "We couldn't do that. Try again.";
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/** An object that never became a `files` row: nothing to keep, so it just goes. */
async function purgeUnregistered(storageKey: string): Promise<void> {
  const admin = createServiceRoleClient();
  const { error } = await admin.storage.from(DELIVERY_BUCKET).remove([storageKey]);
  if (error) console.error(`[deliveries] could not remove ${storageKey}: ${error.message}`);
}

/**
 * Deletes the objects and marks the `files` row purged, keeping the evidence
 * columns spec §12 requires — hash, name, size, timestamp — forever.
 */
async function purgeFile(
  fileId: string,
  storageKey: string,
  previewKey: string | null,
): Promise<void> {
  const admin = createServiceRoleClient();

  const keys = previewKey ? [storageKey, previewKey] : [storageKey];
  const { error: removeError } = await admin.storage.from(DELIVERY_BUCKET).remove(keys);

  // A missing object is the state we wanted; anything else is worth knowing
  // about, but not worth failing the worker's action over.
  if (removeError) {
    console.error(`[deliveries] could not remove ${storageKey}: ${removeError.message}`);
  }

  const { error } = await admin
    .from("files")
    .update({ purged_at: new Date().toISOString(), retention_reason: "delivery file removed" })
    .eq("id", fileId)
    .is("purged_at", null);

  if (error) console.error(`[deliveries] could not mark ${fileId} purged: ${error.message}`);
}

/**
 * Builds the watermarked derivative and hangs it off the `files` row.
 *
 * Runs at registration rather than at submit, so the cost is one file at a time
 * while the worker is still assembling the delivery, and sending is a single
 * fast call. Returns whether a preview now exists — the worker is told, because
 * it changes what the client can see before deciding.
 *
 * Every failure path leaves `preview_key` null, and a null `preview_key` means
 * the client sees a locked row. There is no arrangement of failures here that
 * ends with them holding the clean file.
 */
async function attachPreview({
  fileId,
  jobId,
  workerId,
  storageKey,
  mimeType,
  sizeBytes,
}: {
  fileId: string;
  jobId: string;
  workerId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
}): Promise<boolean> {
  const kind = previewKindFor(mimeType);
  if (kind !== "image" && kind !== "pdf") return false;
  if (sizeBytes > PREVIEW_MAX_SOURCE_BYTES) return false;

  const admin = createServiceRoleClient();

  const { data: blob, error: downloadError } = await admin.storage
    .from(DELIVERY_BUCKET)
    .download(storageKey);

  if (downloadError || !blob) {
    console.error(
      `[deliveries] could not read ${storageKey} to watermark it: ${downloadError?.message ?? "no body"}`,
    );
    return false;
  }

  const preview = await generatePreview({
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    label: watermarkLabel(jobId),
  });

  if (!preview.ok) return false;

  // Its own prefix, which no storage policy covers: only the service-role key
  // writes here and only a signed URL reads it.
  const previewKey = `${DELIVERY_PREVIEW_PREFIX}/${workerId}/${jobId}/${crypto.randomUUID()}.${preview.extension}`;

  const { error: uploadError } = await admin.storage
    .from(DELIVERY_BUCKET)
    .upload(previewKey, new Blob([preview.bytes], { type: preview.mimeType }), {
      contentType: preview.mimeType,
      upsert: false,
    });

  if (uploadError) {
    console.error(`[deliveries] could not store ${previewKey}: ${uploadError.message}`);
    return false;
  }

  const { error: markError } = await admin
    .from("files")
    .update({ preview_key: previewKey, preview_generated_at: new Date().toISOString() })
    .eq("id", fileId);

  if (markError) {
    console.error(`[deliveries] could not record ${previewKey}: ${markError.message}`);
    // An object nothing points at is litter, and litter in this bucket is a
    // watermarked copy of someone's work.
    await admin.storage.from(DELIVERY_BUCKET).remove([previewKey]);
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// The worker: staging files
// ---------------------------------------------------------------------------

export async function registerDeliveryFile(input: {
  jobId: string;
  storageKey: string;
  originalName: string;
  sha256: string;
}): Promise<RegisterFileResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(input.jobId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  // The storage policy already pins the owner segment; this pins the job too, so
  // one upload cannot be staged against two of them.
  const expectedPrefix = `${DELIVERY_PREFIX}/${context.user.id}/${input.jobId}/`;
  const leaf = input.storageKey.startsWith(expectedPrefix)
    ? input.storageKey.slice(expectedPrefix.length)
    : null;

  // Deliberately no purge on this branch: a key that is not ours is not ours to
  // delete.
  if (!leaf || leaf.length === 0 || leaf.includes("/") || leaf.includes("..")) {
    return { ok: false, error: "That upload didn't land where we expected." };
  }

  if (!SHA256_PATTERN.test(input.sha256)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "That upload couldn't be checksummed. Try again." };
  }

  // `assigned workers read their job` (0006) is what returns this.
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, status, assigned_worker_id, categories (max_upload_bytes)")
    .eq("id", input.jobId)
    .maybeSingle();

  if (jobError) throw new Error(`Could not load job ${input.jobId}: ${jobError.message}`);

  if (!job || job.assigned_worker_id !== context.user.id) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "That job isn't yours to deliver." };
  }

  if (job.status !== "assigned" && job.status !== "revision_requested") {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "This job isn't waiting on a delivery right now." };
  }

  const maxUploadBytes = job.categories?.max_upload_bytes ?? DEFAULT_MAX_DELIVERY_BYTES;

  // The cap is per *attempt*, so anything already sent on attempt 1 does not
  // count against attempt 2 — the storage prefix covers the whole job, which is
  // why the sent ones are subtracted rather than filtered out in the query.
  const { data: existing, error: countError } = await supabase
    .from("files")
    .select("id")
    .eq("owner_id", context.user.id)
    .eq("purpose", "delivery")
    .is("purged_at", null)
    .like("storage_key", `${expectedPrefix}%`);

  if (countError) throw new Error(`Could not count delivery files: ${countError.message}`);

  const fileIds = (existing ?? []).map((file) => file.id);
  let sent = 0;

  if (fileIds.length > 0) {
    const { data: attached, error: attachedError } = await supabase
      .from("delivery_files")
      .select("file_id")
      .in("file_id", fileIds);

    if (attachedError) {
      throw new Error(`Could not count sent files: ${attachedError.message}`);
    }

    sent = new Set((attached ?? []).map((row) => row.file_id)).size;
  }

  if (fileIds.length - sent >= MAX_FILES_PER_DELIVERY) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: `${MAX_FILES_PER_DELIVERY} files is the limit on one delivery.` };
  }

  const { data: info, error: infoError } = await supabase.storage
    .from(DELIVERY_BUCKET)
    .info(input.storageKey);

  if (infoError || !info) {
    return { ok: false, error: "We couldn't find that upload. Try adding it again." };
  }

  const sizeBytes = info.size ?? 0;
  const mimeType = info.contentType ?? "application/octet-stream";

  if (sizeBytes <= 0 || sizeBytes > maxUploadBytes) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: `Deliveries on this job top out at ${formatBytes(maxUploadBytes)}.` };
  }

  if (!(ALLOWED_DELIVERY_MIME_TYPES as readonly string[]).includes(mimeType)) {
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "We don't accept that kind of file as a delivery." };
  }

  const originalName = input.originalName.replace(/\p{C}/gu, "").slice(0, 255).trim();

  const { data: file, error: fileError } = await supabase
    .from("files")
    .insert({
      owner_id: context.user.id,
      purpose: "delivery",
      bucket: DELIVERY_BUCKET,
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
      return { ok: false, error: "That file is already attached to this delivery." };
    }
    console.error(`[deliveries] could not register a file: ${fileError.message}`);
    await purgeUnregistered(input.storageKey);
    return { ok: false, error: "We couldn't save that. Try again." };
  }

  const hasPreview = await attachPreview({
    fileId: file.id,
    jobId: input.jobId,
    workerId: context.user.id,
    storageKey: input.storageKey,
    mimeType,
    sizeBytes,
  });

  revalidatePath(WORKER_ROUTES.deliver(input.jobId));

  return {
    ok: true,
    file: {
      fileId: file.id,
      name: originalName || leaf,
      mimeType,
      sizeBytes,
      hasPreview,
    },
  };
}

/** Only before it has been sent. Once a delivery names it, it is evidence. */
export async function removeDeliveryFile(
  jobId: string,
  fileId: string,
): Promise<SimpleResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(fileId)) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { data: file, error } = await supabase
    .from("files")
    .select("id, owner_id, storage_key, preview_key")
    .eq("id", fileId)
    .maybeSingle();

  if (error) throw new Error(`Could not load file ${fileId}: ${error.message}`);

  if (
    !file ||
    file.owner_id !== context.user.id ||
    !file.storage_key.startsWith(`${DELIVERY_PREFIX}/${context.user.id}/${jobId}/`)
  ) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { data: sent, error: sentError } = await supabase
    .from("delivery_files")
    .select("delivery_id")
    .eq("file_id", fileId)
    .limit(1);

  if (sentError) throw new Error(`Could not check file ${fileId}: ${sentError.message}`);

  if ((sent ?? []).length > 0) {
    return { ok: false, error: "That file has already been sent, so it can't be removed." };
  }

  await purgeFile(file.id, file.storage_key, file.preview_key);

  revalidatePath(WORKER_ROUTES.deliver(jobId));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The worker: sending it
// ---------------------------------------------------------------------------

export async function submitDelivery(input: {
  jobId: string;
  note: string;
  fileIds: string[];
}): Promise<SubmitDeliveryResult> {
  const context = await requireRole("worker");

  if (!UUID_PATTERN.test(input.jobId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  const note = parseDeliveryNote(input.note);
  if (!note.ok) {
    return { ok: false, error: "Check the note.", fieldErrors: note.fieldErrors };
  }

  const fileIds = input.fileIds.filter((id) => UUID_PATTERN.test(id));

  if (fileIds.length === 0) {
    return { ok: false, error: "Attach at least one file before you send this." };
  }
  if (fileIds.length > MAX_FILES_PER_DELIVERY) {
    return { ok: false, error: `${MAX_FILES_PER_DELIVERY} files is the limit on one delivery.` };
  }

  const admin = createServiceRoleClient();

  // Returns one `job_deliveries` row, not a set, so no `.single()` here.
  // The empty string is what the function's own `nullif(btrim(…), '')` turns
  // back into null: the generated argument type is `string`, never
  // `string | null`.
  const { data: delivery, error } = await admin.rpc("submit_job_delivery", {
    p_job_id: input.jobId,
    p_worker_id: context.user.id,
    p_note: note.value ?? "",
    p_file_ids: fileIds,
  });

  if (error || !delivery) {
    return {
      ok: false,
      error: error
        ? describeRpcError(error, `submit_job_delivery on ${input.jobId}`)
        : "We couldn't send that. Try again.",
    };
  }

  revalidatePath(WORKER_ROUTES.work);
  revalidatePath(WORKER_ROUTES.deliver(input.jobId));
  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.review(input.jobId));

  return { ok: true, autoAcceptAt: delivery.auto_accept_at, attempt: delivery.attempt };
}

// ---------------------------------------------------------------------------
// The client: accepting, or asking once for changes
// ---------------------------------------------------------------------------

/**
 * Spec §5: "Accept → escrow releases." Everything that means happens inside
 * `accept_job_delivery()` in one transaction — the release, the ledger, the
 * worker's earning, the job, the assignment and the unlock of the clean files.
 */
export async function acceptDelivery(deliveryId: string): Promise<SimpleResult> {
  const context = await requireRole("client");

  if (!UUID_PATTERN.test(deliveryId)) {
    return { ok: false, error: "That delivery doesn't exist." };
  }

  const admin = createServiceRoleClient();

  const { data: accepted, error } = await admin.rpc("accept_job_delivery", {
    p_delivery_id: deliveryId,
    p_actor_id: context.user.id,
    p_auto: false,
  });

  if (error || !accepted) {
    return {
      ok: false,
      error: error
        ? describeRpcError(error, `accept_job_delivery ${deliveryId}`)
        : "We couldn't accept that. Try again.",
    };
  }

  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.review(accepted.job_id));
  revalidatePath(WORKER_ROUTES.work);
  revalidatePath(WORKER_ROUTES.deliver(accepted.job_id));

  return { ok: true };
}

/**
 * Spec §5: "Request revision → 1 free." A second needs the worker to agree and
 * becomes a dispute if they do not, and neither of those is built — so
 * `request_job_revision()` refuses past the free one and this reports that
 * rather than pretending the request went somewhere.
 */
export async function requestRevision(input: {
  deliveryId: string;
  reason: string;
}): Promise<RevisionResult> {
  const context = await requireRole("client");

  if (!UUID_PATTERN.test(input.deliveryId)) {
    return { ok: false, error: "That delivery doesn't exist." };
  }

  const reason = parseRevisionReason(input.reason);
  if (!reason.ok) {
    return { ok: false, error: "Check the reason.", fieldErrors: reason.fieldErrors };
  }

  const admin = createServiceRoleClient();

  const { data: revision, error } = await admin.rpc("request_job_revision", {
    p_delivery_id: input.deliveryId,
    p_actor_id: context.user.id,
    p_reason: reason.value,
  });

  if (error || !revision) {
    return {
      ok: false,
      error: error
        ? describeRpcError(error, `request_job_revision ${input.deliveryId}`)
        : "We couldn't send that. Try again.",
    };
  }

  revalidatePath(JOB_ROUTES.dashboard);
  revalidatePath(JOB_ROUTES.review(revision.job_id));
  revalidatePath(WORKER_ROUTES.work);
  revalidatePath(WORKER_ROUTES.deliver(revision.job_id));

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Opening a file
// ---------------------------------------------------------------------------

/** A short-lived link so a worker can check what they uploaded before sending. */
export async function openStagedFile(
  jobId: string,
  fileId: string,
): Promise<OpenFileResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(fileId)) {
    return { ok: false, error: "That file doesn't exist." };
  }

  // `owners read their own files` is what returns this, and the prefix check
  // keeps one worker's job from opening another's.
  const { data: file, error } = await supabase
    .from("files")
    .select("owner_id, storage_key")
    .eq("id", fileId)
    .maybeSingle();

  if (error) throw new Error(`Could not load file ${fileId}: ${error.message}`);

  if (
    !file ||
    file.owner_id !== context.user.id ||
    !file.storage_key.startsWith(`${DELIVERY_PREFIX}/${context.user.id}/${jobId}/`)
  ) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(DELIVERY_BUCKET)
    .createSignedUrl(file.storage_key, DELIVERY_URL_TTL_SECONDS);

  if (signError || !signed) {
    console.error(`[deliveries] could not sign ${fileId}: ${signError?.message}`);
    return { ok: false, error: "We couldn't open that file. Try again." };
  }

  return { ok: true, kind: "url", url: signed.signedUrl, watermarked: false };
}

/**
 * A delivered file, as far as the person asking is allowed to see it.
 *
 * The guard is the RLS-scoped read of `delivery_files`: `delivered files are
 * visible to both sides` returns nothing to anyone who is not the client, the
 * assigned worker or an admin. What comes back after that is decided by
 * `deliveryFileAccess`, and the signed URL — minted with the service-role key,
 * because no policy hands a client someone else's object — is only ever for the
 * key that decision names.
 */
export async function openDeliveredFile(
  deliveryId: string,
  fileId: string,
): Promise<OpenFileResult> {
  const context = await requireUser();
  const supabase = await createClient();

  if (!UUID_PATTERN.test(deliveryId) || !UUID_PATTERN.test(fileId)) {
    return { ok: false, error: "That file doesn't exist." };
  }

  const { data: attached, error } = await supabase
    .from("delivery_files")
    .select("file_id, unlocked_at")
    .eq("delivery_id", deliveryId)
    .eq("file_id", fileId)
    .maybeSingle();

  if (error) throw new Error(`Could not load delivery file ${fileId}: ${error.message}`);
  if (!attached) return { ok: false, error: "That file doesn't exist." };

  const admin = createServiceRoleClient();

  const { data: file, error: fileError } = await admin
    .from("files")
    .select("owner_id, storage_key, preview_key, mime_type, size_bytes")
    .eq("id", fileId)
    .is("purged_at", null)
    .maybeSingle();

  if (fileError || !file) {
    return { ok: false, error: "That file isn't available any more." };
  }

  // The worker looking at their own work. `deliveryFileAccess` answers the
  // question "how much of someone else's file may this person see", and the
  // owner is not someone else.
  const access =
    file.owner_id === context.user.id
      ? "clean"
      : deliveryFileAccess({
          unlocked: attached.unlocked_at !== null,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          hasPreview: file.preview_key !== null,
        });

  if (access === "locked") {
    return { ok: false, error: describeLocked(file.mime_type) };
  }

  if (access === "text") {
    return readTextPreview(file.storage_key);
  }

  const key = access === "clean" ? file.storage_key : file.preview_key;

  if (!key) {
    return { ok: false, error: "That file isn't available any more." };
  }

  const { data: signed, error: signError } = await admin.storage
    .from(DELIVERY_BUCKET)
    .createSignedUrl(key, DELIVERY_URL_TTL_SECONDS);

  if (signError || !signed) {
    console.error(`[deliveries] could not sign ${key}: ${signError?.message}`);
    return { ok: false, error: "We couldn't open that file. Try again." };
  }

  return { ok: true, kind: "url", url: signed.signedUrl, watermarked: access === "preview" };
}

/**
 * Spec §6's "viewable but not downloadable": the body comes back as text and no
 * URL is minted at all, so there is no address to paste anywhere. Copying what
 * is on screen is still possible and always will be — the point is that the
 * file itself has not changed hands.
 */
async function readTextPreview(storageKey: string): Promise<OpenFileResult> {
  const admin = createServiceRoleClient();

  const { data: blob, error } = await admin.storage.from(DELIVERY_BUCKET).download(storageKey);

  if (error || !blob) {
    console.error(`[deliveries] could not read ${storageKey}: ${error?.message ?? "no body"}`);
    return { ok: false, error: "We couldn't open that file. Try again." };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const truncated = bytes.byteLength > TEXT_PREVIEW_MAX_BYTES;

  // A cut in the middle of a multi-byte character decodes to one replacement
  // character at the very end, which is a better outcome than reading a
  // 25MB file into the page.
  const body = new TextDecoder("utf-8").decode(bytes.slice(0, TEXT_PREVIEW_MAX_BYTES));

  return { ok: true, kind: "text", body, truncated };
}
