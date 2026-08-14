/**
 * Job posting constants.
 *
 * Every number here has its authority elsewhere — a CHECK, a trigger, or a
 * `platform_settings` row. These copies exist so a form can validate before a
 * round trip and so a label can quote the rule. A stale constant here makes a
 * message wrong; it never makes a limit loose.
 */

/** Spec §5. Also `jobs_publishable` and `job.min_budget_paise`. */
export const MIN_BUDGET_PAISE = 14_900;
/** Spec §10 — capped for the first three months. `job.max_budget_paise`. */
export const MAX_BUDGET_PAISE = 500_000;

export const TITLE_MIN_LENGTH = 5;
export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MIN_LENGTH = 20;
export const DESCRIPTION_MAX_LENGTH = 5_000;

/**
 * Spec §5: the deadline a client may set is capped by what the job is worth.
 * Mirrors `public.max_deadline_days()`, which is what actually enforces it.
 */
export const DEADLINE_CAPS = [
  { belowPaise: 200_000, days: 7 },
  { belowPaise: 500_000, days: 15 },
] as const;

export const MAX_DEADLINE_DAYS = 30;

export function maxDeadlineDays(budgetPaise: number): number {
  for (const cap of DEADLINE_CAPS) {
    if (budgetPaise < cap.belowPaise) return cap.days;
  }
  return MAX_DEADLINE_DAYS;
}

/**
 * "Other" is where an unclassified brief lands (spec §5). Picking it sets
 * `posted_as_other` and leaves `category_id` null for an admin to resolve.
 */
export const OTHER_CATEGORY_SLUG = "other";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Matches `public.files.bucket`'s default. Supabase Storage until R2 lands. */
export const ATTACHMENT_BUCKET = "zevi-uploads";
/** First path segment. The storage policies in migration 0023 anchor on it. */
export const ATTACHMENT_PREFIX = "job-attachments";

export const MAX_ATTACHMENTS_PER_JOB = 10;

/** Used when a category sets no `max_upload_bytes` of its own. Spec §12. */
export const DEFAULT_MAX_UPLOAD_BYTES = 104_857_600;

/**
 * What a client may attach to a brief: reference material, brand assets, source
 * footage. Deliberately a list rather than a wildcard — an upload form that
 * accepts anything is a malware host with extra steps.
 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/heic",
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
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
] as const;

/** Signed download link for an attachment the client already uploaded. */
export const ATTACHMENT_URL_TTL_SECONDS = 60;

// ---------------------------------------------------------------------------
// The form itself
// ---------------------------------------------------------------------------

/**
 * Long enough that a sentence typed at speed is one save, short enough that
 * closing the tab mid-thought loses nothing worth mourning.
 */
export const AUTOSAVE_DEBOUNCE_MS = 1_200;

export const JOB_ROUTES = {
  post: "/post",
  dashboard: "/dashboard",
  edit: (jobId: string) => `/post/${jobId}`,
} as const;

/** Statuses whose brief a client may still change (spec §5). */
export const EDITABLE_JOB_STATUSES = ["draft", "pending_moderation", "open"] as const;
