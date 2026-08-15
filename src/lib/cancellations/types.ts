/**
 * What `cancelJob()` gives back.
 *
 * Kept out of `actions.ts` because a `"use server"` module may only export async
 * functions.
 */

import type { CancellationTier } from "@/lib/cancellations/tiers";
import type { FieldErrors } from "@/lib/disputes/types";

/**
 * Two shapes of success, because spec §5's table has two shapes of outcome.
 *
 *   cancelled  the job is over and the money is divided. The three figures are
 *              what the client is told, and they came back from the function
 *              rather than from the quote the screen showed — if the clock moved
 *              a tier between the preview and the click, this is the truth.
 *   assessed   more than half the deadline had gone, so nothing is divided yet
 *              and a person is now reading it. The job is still standing.
 */
export type CancelResult =
  | {
      ok: true;
      outcome: "cancelled";
      tier: CancellationTier;
      clientRefundPaise: number;
      workerPaise: number;
      feePaise: number;
    }
  | { ok: true; outcome: "assessed"; disputeId: string | null; detail: string | null }
  | { ok: false; error: string; fieldErrors?: FieldErrors };
