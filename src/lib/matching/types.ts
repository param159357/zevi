/**
 * The shapes the feed queries and the opt-in actions take and return.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export
 * async functions.
 */

import type { JobStatus } from "@/lib/jobs/types";
import type { WorkerStatus } from "@/lib/workers/types";
import type { Database } from "@/types/database.types";

export type OptInStatus = Database["public"]["Enums"]["opt_in_status"];

/** Keyed by input name, like the auth and job forms. */
export type FieldErrors = Record<string, string>;

/** One of the worker's up-to-three categories, as a filter tab. */
export type FeedCategory = {
  id: string;
  name: string;
  /** Open jobs in it right now, so a tab can say whether it is worth a click. */
  jobCount: number;
};

/**
 * What spec §6 puts on a card about the person posting: their rating and how
 * many jobs they have completed. Everything here comes from `client_profiles`
 * and `public_profiles`, both of which are public by policy — no part of this
 * is trimmed from a wider SELECT.
 */
export type FeedClient = {
  displayName: string;
  rating: number | null;
  jobsCompleted: number;
};

/** A feed card. Spec §6: title, budget, deadline, client rating, jobs
 *  completed, and how many have already opted in. */
export type FeedJob = {
  id: string;
  title: string;
  categoryId: string | null;
  categoryName: string | null;
  budgetPaise: number;
  deadlineAt: string | null;
  publishedAt: string | null;
  optInCount: number;
  client: FeedClient;
  /** Their own opt-in on this job, if they already have one. */
  optedIn: boolean;
};

/** The card, plus the brief itself. */
export type FeedBrief = FeedJob & {
  description: string;
  status: JobStatus;
  expiresAt: string | null;
};

/**
 * Spec §6's five active opt-ins, as the trigger computes it:
 * `worker_state.opt_in_limit_override` first, then
 * `platform_settings.matching.max_active_opt_ins`.
 */
export type OptInCapacity = {
  used: number;
  cap: number;
  atCap: boolean;
};

/** Everything `/worker/jobs` renders. */
export type WorkerFeed = {
  workerStatus: WorkerStatus;
  categories: FeedCategory[];
  /** The filter in play, or null for all of them. */
  activeCategoryId: string | null;
  jobs: FeedJob[];
  /** More open jobs exist than one page holds. */
  truncated: boolean;
  capacity: OptInCapacity;
  dwellSeconds: number;
};

/** A row on `/worker/opt-ins`. */
export type ActiveOptIn = {
  id: string;
  status: OptInStatus;
  createdAt: string;
  software: string;
  turnaround: string;
  noticed: string;
  job: {
    id: string;
    title: string;
    status: JobStatus;
    categoryName: string | null;
    budgetPaise: number | null;
    deadlineAt: string | null;
  };
};

/** Exactly what the opt-in form holds. */
export type OptInFormValues = {
  software: string;
  turnaround: string;
  noticed: string;
};

export type OptInInput = OptInFormValues & {
  jobId: string;
  /**
   * When the server rendered the brief. Handed to the browser and posted back,
   * so it is the worker's word for how long they read — see the note on the
   * dwell check in `actions.ts`.
   */
  briefOpenedAt: string;
};

export type OptInResult =
  | { ok: true }
  | { ok: false; error?: string; fieldErrors?: FieldErrors };

export type SimpleResult = { ok: true } | { ok: false; error: string };
