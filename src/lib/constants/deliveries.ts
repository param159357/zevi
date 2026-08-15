/**
 * Delivery constants — spec §5 "Reviewing delivery" and §6 "Delivery".
 *
 * Same rule as the job and worker constants: every number here has its authority
 * in the database — a CHECK, a trigger, or a `platform_settings` row read by
 * migration 0030. These copies let a form validate before a round trip and let a
 * label quote the rule. A stale constant makes a message wrong, never a limit
 * loose.
 */

/** Matches `public.files.bucket`'s default. Supabase Storage until R2 lands. */
export const DELIVERY_BUCKET = "zevi-uploads";

/**
 * First path segment of a worker's own upload. The storage policies in
 * migration 0030 anchor on it, and on the owner id in the second segment.
 */
export const DELIVERY_PREFIX = "deliveries";

/**
 * Where the watermarked derivative goes. Deliberately a *different* prefix with
 * no storage policy at all: only the service-role key writes here, and only a
 * signed URL reads it. A worker who could overwrite their own preview could hand
 * the client a clean file before acceptance.
 */
export const DELIVERY_PREVIEW_PREFIX = "delivery-previews";

/**
 * The one number here with no database rule behind it — `submit_job_delivery()`
 * takes whatever array it is given. Same position as `MAX_ATTACHMENTS_PER_JOB`:
 * a limit on how much a form should hold, not an invariant of the data.
 */
export const MAX_FILES_PER_DELIVERY = 10;

/** Used when a category sets no `max_upload_bytes` of its own. Spec §12. */
export const DEFAULT_MAX_DELIVERY_BYTES = 104_857_600;

/** Mirrors `char_length(note) <= 2000` on `job_deliveries`. */
export const DELIVERY_NOTE_MAX_LENGTH = 2_000;

/** Mirrors `char_length(reason) between 10 and 1000` on `job_revisions`. */
export const REVISION_REASON_MIN_LENGTH = 10;
export const REVISION_REASON_MAX_LENGTH = 1_000;

/**
 * Spec §5. Mirrors `stamp_auto_accept_deadline()`, which reads the same three
 * numbers from `platform_settings` and is what actually decides the deadline —
 * computed once, at delivery, and stored on the row.
 */
export const AUTO_ACCEPT_THRESHOLD_PAISE = 100_000;
export const AUTO_ACCEPT_HOURS_UNDER = 36;
export const AUTO_ACCEPT_DAYS_FROM = 3;

/** `platform_settings`: delivery.free_revisions. Spec §5 gives exactly one. */
export const FREE_REVISIONS = 1;

/** `platform_settings`: files.retention_days_accepted. Spec §12. */
export const RETENTION_DAYS_ACCEPTED = 7;

/**
 * How many deliveries one sweep will accept. Well above what an hourly run on a
 * platform doing 200 jobs a month will ever find, and low enough that a backlog
 * after an outage is drained over several runs rather than in one request that
 * times out halfway through.
 */
export const AUTO_ACCEPT_SWEEP_LIMIT = 100;

/** How long a client has been promised, in words, before anything is delivered. */
export function autoAcceptWindowLabel(budgetPaise: number): string {
  return budgetPaise < AUTO_ACCEPT_THRESHOLD_PAISE
    ? `${AUTO_ACCEPT_HOURS_UNDER} hours`
    : `${AUTO_ACCEPT_DAYS_FROM} days`;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * What a worker may deliver. Wider than the sample list — a delivery is the
 * actual work, so source files and archives belong — but still a list rather
 * than a wildcard.
 */
export const ALLOWED_DELIVERY_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "application/x-zip-compressed",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "audio/wav",
] as const;

/**
 * What sharp can rasterise, and therefore what we can genuinely watermark.
 * Anything outside this list and PDF is shown to the client as a locked row —
 * see `previewKindFor` below for why that is the honest answer.
 */
export const WATERMARKABLE_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/tiff",
  "image/svg+xml",
] as const;

/**
 * Spec §6: "code, documents, spreadsheets — viewable but not downloadable until
 * acceptance". These are the ones we can honestly show inline: the body is read
 * server-side and rendered as text, and no URL to the object is ever minted.
 */
export const TEXT_VIEWABLE_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
] as const;

/**
 * How a file is shown to the client *before* acceptance.
 *
 *   image · pdf   a real watermarked derivative, generated server-side
 *   text          the body, inline, with no download link
 *   none          name, size and type only
 *
 * `none` is not a gap waiting to be filled with something that looks like a
 * preview. Watermarking a video needs ffmpeg and rendering a PPTX or a DOCX
 * needs a converter; neither exists in this stack, and showing an unwatermarked
 * frame or an unwatermarked page would hand over the work the escrow is holding
 * money against. The worker-facing copy asks for a PDF export alongside the
 * source file, which is the version of this the client can actually judge.
 */
export type PreviewKind = "image" | "pdf" | "text" | "none";

export function previewKindFor(mimeType: string): PreviewKind {
  if ((WATERMARKABLE_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if ((TEXT_VIEWABLE_MIME_TYPES as readonly string[]).includes(mimeType)) return "text";
  return "none";
}

/**
 * Above this, no preview is generated and the file stays locked until
 * acceptance. Matches `files.max_bytes_document` (spec §12's 25MB): a preview is
 * built by pulling the whole object into a Server Action, and a 500MB source
 * video has no business going through one — which is the same reason uploads go
 * straight from the browser to storage.
 */
export const PREVIEW_MAX_SOURCE_BYTES = 26_214_400;

/** Longest edge of a raster preview. Enough to judge the work, not to use it. */
export const PREVIEW_MAX_EDGE = 1_600;

/** How much of a text file the client may read before accepting. */
export const TEXT_PREVIEW_MAX_BYTES = 65_536;

/**
 * Signed links live longer than a sample's 60 seconds: a client opens several
 * while deciding, and a worker checks what they uploaded before sending it.
 */
export const DELIVERY_URL_TTL_SECONDS = 300;
