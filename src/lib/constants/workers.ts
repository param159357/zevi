/**
 * Worker onboarding constants.
 *
 * Same rule as the job constants: every number here has its authority in the
 * database — a CHECK, a trigger, a `categories` column or a `platform_settings`
 * row. These copies let a form validate before a round trip and let a label
 * quote the rule. A stale constant makes a message wrong, never a limit loose.
 */

/** Spec §6, and `categories.sample_min` / `sample_max`, which override per
 *  category. These are the defaults the copy quotes before one is loaded. */
export const SAMPLE_MIN_PER_CATEGORY = 3;
export const SAMPLE_MAX_PER_CATEGORY = 6;

/** Mirrors the `char_length(caption) between 5 and 160` check in 0005. */
export const CAPTION_MIN_LENGTH = 5;
export const CAPTION_MAX_LENGTH = 160;

/** `platform_settings`: worker.approval_sla_hours and worker.resubmit_after_days. */
export const APPROVAL_SLA_HOURS = 24;
export const RESUBMIT_AFTER_DAYS = 7;

/** Spec §6 allows one resubmission, and `worker_applications.attempt` caps it. */
export const MAX_APPLICATION_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Sample files
// ---------------------------------------------------------------------------

/** Matches `public.files.bucket`'s default. Supabase Storage until R2 lands. */
export const SAMPLE_BUCKET = "zevi-uploads";
/** First path segment. The storage policies in migration 0027 anchor on it. */
export const SAMPLE_PREFIX = "worker-samples";

/** Used when a category sets no `max_upload_bytes` of its own. Spec §12. */
export const DEFAULT_MAX_SAMPLE_BYTES = 104_857_600;

/**
 * What counts as a sample: finished work, in the format the category is
 * delivered in (spec §6 — a deck is the file or a PDF export, never a
 * screenshot of one). Narrower than the attachment list on purpose; a brief can
 * carry a zip of source footage, a portfolio piece cannot.
 */
export const ALLOWED_SAMPLE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "video/mp4",
  "video/quicktime",
] as const;

export function isImageSample(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

export function isVideoSample(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

/** Short-lived link so a worker can check what they uploaded. */
export const SAMPLE_URL_TTL_SECONDS = 60;

/**
 * Longer, because a reviewer opens several in a sitting and because the reverse
 * image search below hands the URL to Google, which fetches it a moment later.
 */
export const REVIEW_URL_TTL_SECONDS = 600;

/**
 * Spec §6: reverse image search on design samples. Google Lens takes the image
 * by URL, which is why the reviewer's signed link outlives the worker's.
 *
 * The signed URL leaves our infrastructure the moment this link is followed —
 * that is the point of it, and it is a reviewer's deliberate click, not
 * something the page does on its own.
 */
export function reverseImageSearchUrl(signedUrl: string): string {
  return `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(signedUrl)}`;
}

export const WORKER_ROUTES = {
  home: "/worker",
  samples: "/worker/samples",
  feed: "/worker/jobs",
  job: (jobId: string) => `/worker/jobs/${jobId}`,
  optIns: "/worker/opt-ins",
  /** Jobs they were picked for. `/worker/jobs` is the feed — what they could
   *  take — and this is what they have. Two different screens about two
   *  different things, so two segments. */
  work: "/worker/work",
  deliver: (jobId: string) => `/worker/work/${jobId}`,
  earnings: "/worker/earnings",
  /** Spec §6 puts KYC before the first payout, not at signup, so it sits under
   *  earnings rather than in the onboarding checklist. */
  kyc: "/worker/kyc",
} as const;

export const ADMIN_ROUTES = {
  home: "/admin",
  approvals: "/admin/approvals",
  application: (applicationId: string) => `/admin/approvals/${applicationId}`,
  kyc: "/admin/kyc",
} as const;
