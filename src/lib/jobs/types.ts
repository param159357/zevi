/**
 * The shapes the job posting actions take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { Database } from "@/types/database.types";

export type JobStatus = Database["public"]["Enums"]["job_status"];

/** Keyed by input name, like the auth forms. */
export type FieldErrors = Record<string, string>;

/** Exactly what the form holds. Everything is a string because a half-typed
 *  budget is still worth saving; the actions parse it. */
export type JobFormValues = {
  categoryId: string | null;
  postedAsOther: boolean;
  title: string;
  description: string;
  /** Rupees, as typed. */
  budget: string;
  /** `yyyy-mm-dd`, the date part of the deadline in India. */
  deadline: string;
};

export type JobDraftInput = JobFormValues & {
  /** Null on the first save of a new post — the action creates the row. */
  jobId: string | null;
};

export type SaveDraftResult =
  | { ok: true; jobId: string; savedAt: string }
  | { ok: false; error?: string; fieldErrors?: FieldErrors };

/** Publishing redirects on success, so only the failure shape returns. */
export type PublishJobResult = {
  ok: false;
  error?: string;
  fieldErrors?: FieldErrors;
};

export type JobAttachment = {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

export type AttachmentResult =
  | { ok: true; attachment: JobAttachment }
  | { ok: false; error: string };

export type AttachmentUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export type SimpleResult = { ok: true } | { ok: false; error: string };

/** The job as the form receives it when resuming a draft or editing a post. */
export type EditableJob = {
  id: string;
  status: JobStatus;
  categoryId: string | null;
  postedAsOther: boolean;
  title: string;
  description: string;
  budgetPaise: number | null;
  deadlineAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

/** A category tile on the posting form. */
export type PostableCategory = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  maxUploadBytes: number | null;
};
