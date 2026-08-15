/**
 * The shapes the delivery queries and actions take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { JobStatus } from "@/lib/jobs/types";
import type { Database } from "@/types/database.types";

export type DeliveryStatus = Database["public"]["Enums"]["delivery_status"];
export type RevisionStatus = Database["public"]["Enums"]["revision_status"];

/** Keyed by input name, like the auth, job and opt-in forms. */
export type FieldErrors = Record<string, string>;

export type SimpleResult = { ok: true } | { ok: false; error: string };

/**
 * How far a given person may see a given delivered file *right now*.
 *
 *   clean    the original. Only ever after `delivery_files.unlocked_at`
 *   preview  the watermarked derivative
 *   text     the body, inline, with no link to the object (spec §6's
 *            "viewable but not downloadable")
 *   locked   name, size and type. Nothing we can watermark, so nothing shown
 *
 * Decided by `deliveryFileAccess()` in `access.ts`, which is the only place
 * this is worked out.
 */
export type DeliveryAccess = "clean" | "preview" | "text" | "locked";

// ---------------------------------------------------------------------------
// The worker's side
// ---------------------------------------------------------------------------

/** An upload that has been registered but not sent yet. */
export type StagedFile = {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** False when it is a type we cannot mark, or was too big to pull through a
   *  Server Action — the worker is told, because it changes what the client
   *  will be able to see before deciding. */
  hasPreview: boolean;
};

// ---------------------------------------------------------------------------
// What both sides read
// ---------------------------------------------------------------------------

export type DeliveredFile = {
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  position: number;
  access: DeliveryAccess;
};

/** One attempt. Attempt 1 is the first delivery, 2 is after the free revision. */
export type DeliveryAttempt = {
  id: string;
  attempt: number;
  status: DeliveryStatus;
  note: string | null;
  deliveredAt: string;
  autoAcceptAt: string;
  acceptedAt: string | null;
  autoAccepted: boolean;
  files: DeliveredFile[];
};

export type RevisionRecord = {
  id: string;
  sequence: number;
  isFree: boolean;
  status: RevisionStatus;
  reason: string;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// The two screens
// ---------------------------------------------------------------------------

/** Everything `/worker/work/[jobId]` renders. */
export type WorkerJobWork = {
  jobId: string;
  title: string;
  description: string;
  status: JobStatus;
  budgetPaise: number;
  deadlineAt: string | null;
  categoryName: string | null;
  maxUploadBytes: number;
  clientName: string;
  /** Newest attempt first. */
  deliveries: DeliveryAttempt[];
  revisions: RevisionRecord[];
  /** Registered, not yet sent. */
  staged: StagedFile[];
  /** The job is waiting on this worker: 'assigned' or 'revision_requested'. */
  canDeliver: boolean;
  earning: {
    status: Database["public"]["Enums"]["earning_status"];
    netPaise: number;
    commissionPaise: number;
    taxPaise: number;
    grossPaise: number;
    eligibleAt: string | null;
    holdUntil: string | null;
    holdReason: string | null;
  } | null;
};

/** A row on `/worker/work`. */
export type WorkerJobSummary = {
  jobId: string;
  title: string;
  status: JobStatus;
  budgetPaise: number;
  deadlineAt: string | null;
  categoryName: string | null;
  /** The attempt awaiting a decision, if there is one. */
  awaitingReviewSince: string | null;
  autoAcceptAt: string | null;
};

/** Everything `/review/[jobId]` renders. */
export type DeliveryReview = {
  jobId: string;
  title: string;
  status: JobStatus;
  budgetPaise: number;
  deadlineAt: string | null;
  categoryName: string | null;
  workerName: string;
  /** Newest attempt first. */
  deliveries: DeliveryAttempt[];
  revisions: RevisionRecord[];
  /** The attempt the buttons act on — the one still `pending_review`. */
  openDeliveryId: string | null;
  /** Spec §5's one free revision, minus what has been used. */
  freeRevisionsLeft: number;
};

// ---------------------------------------------------------------------------
// Action results
// ---------------------------------------------------------------------------

export type RegisterFileResult =
  | { ok: true; file: StagedFile }
  | { ok: false; error: string };

export type SubmitDeliveryResult =
  | { ok: true; autoAcceptAt: string; attempt: number }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

export type RevisionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

/**
 * What opening a delivered file gives you. A `text` body never comes with a
 * URL, which is the whole of "viewable but not downloadable": there is no
 * address for the object to paste anywhere.
 */
export type OpenFileResult =
  | { ok: true; kind: "url"; url: string; watermarked: boolean }
  | { ok: true; kind: "text"; body: string; truncated: boolean }
  | { ok: false; error: string };
