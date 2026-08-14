/**
 * The shapes the worker onboarding actions and queries take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { Database } from "@/types/database.types";

export type ApplicationStatus =
  Database["public"]["Enums"]["worker_application_status"];
export type SampleStatus = Database["public"]["Enums"]["sample_status"];
export type WorkerStatus = Database["public"]["Enums"]["worker_status"];

export type WorkerSample = {
  id: string;
  categoryId: string;
  fileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  caption: string;
  status: SampleStatus;
  rejectionReason: string | null;
  position: number;
};

/** One of the worker's up-to-three categories, with everything the upload panel
 *  needs to police itself before a round trip. */
export type SampleCategory = {
  id: string;
  name: string;
  /** Spec §6: "PPT → actual file or PDF; video → 60s max". */
  formatNote: string | null;
  sampleMin: number;
  sampleMax: number;
  maxUploadBytes: number;
  samples: WorkerSample[];
};

export type WorkerApplication = {
  id: string;
  attempt: number;
  status: ApplicationStatus;
  submittedAt: string | null;
  slaDueAt: string | null;
  reviewedAt: string | null;
  /** Shown to the worker on a rejection — spec §6 rejects *with a reason*. */
  decisionReason: string | null;
  resubmitAfter: string | null;
};

/** Everything `/worker/samples` renders. */
export type SampleWorkspace = {
  workerStatus: WorkerStatus;
  application: WorkerApplication | null;
  categories: SampleCategory[];
  /** Frozen while an attempt is in review, and once it is approved. */
  locked: boolean;
  /** Every category has met its minimum, so the submit button means something. */
  readyToSubmit: boolean;
};

export type SampleResult =
  | { ok: true; sample: WorkerSample }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export type SampleUrlResult = { ok: true; url: string } | { ok: false; error: string };

export type SimpleResult = { ok: true } | { ok: false; error: string };

export type SubmitApplicationResult =
  | { ok: true; slaDueAt: string | null }
  | { ok: false; error: string };
