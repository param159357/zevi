/**
 * The shapes the admin console's actions and queries take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { SampleStatus, WorkerStatus } from "@/lib/workers/types";

/** Spec §6: approve · reject with reason · approve-with-flag. */
export const REVIEW_DECISIONS = ["approve", "approve_with_flag", "reject"] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: unknown): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly unknown[]).includes(value);
}

/** A row in the queue, ordered by what is closest to breaching its SLA. */
export type ApprovalQueueRow = {
  applicationId: string;
  workerId: string;
  workerName: string;
  attempt: number;
  submittedAt: string | null;
  slaDueAt: string | null;
  categoryNames: string[];
  sampleCount: number;
};

export type ReviewSample = {
  id: string;
  caption: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: SampleStatus;
  /** Short-lived, minted server-side. Null if the object has gone. */
  previewUrl: string | null;
  /** Spec §6: reverse image search on design samples. Images only. */
  reverseSearchUrl: string | null;
};

export type ReviewCategory = {
  id: string;
  name: string;
  sampleMin: number;
  sampleMax: number;
  formatNote: string | null;
  samples: ReviewSample[];
};

/** One application, as the review screen needs it. */
export type ApplicationReview = {
  applicationId: string;
  workerId: string;
  /** Full legal name — spec §6 has the reviewer check it against the ID. */
  workerName: string;
  workerEmail: string;
  workerStatus: WorkerStatus;
  memberSince: string;
  attempt: number;
  status: string;
  submittedAt: string | null;
  slaDueAt: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  categories: ReviewCategory[];
};

export type ReviewFormState = {
  status: "idle" | "error";
  error?: string;
  fieldErrors?: Record<string, string>;
};

export const IDLE_REVIEW_STATE: ReviewFormState = { status: "idle" };
