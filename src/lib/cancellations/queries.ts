/**
 * What a client needs to see before they cancel — spec §5.
 *
 * One read, under the caller's own client (`clients read their own jobs`, 0006),
 * turned into a quote by `lib/cancellations/tiers.ts`. The quote is a *preview*:
 * `request_job_cancellation()` derives the tier again from its own `now()` and
 * its own settings, under the job's row lock, and that is the decision. If the
 * two disagree — a clock skew, a confirmation screen left open for an hour — the
 * function wins and the action reports what it actually did.
 *
 * That is the same division `lib/payouts/cycle.ts` has with
 * `build_payout_batch()`, and it exists for the same reason: a client cannot be
 * asked to confirm an irreversible thing without being told what it costs, and
 * asking the database for a number it is about to recompute is two round trips
 * and one more place to drift.
 */

import {
  type CancellationQuote,
  quoteCancellation,
} from "@/lib/cancellations/tiers";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statuses where cancelling is a thing that can happen at all. Everything
 *  else is finished, and `request_job_cancellation()` says so by name. */
const CANCELLABLE_STATUSES = [
  "draft",
  "pending_moderation",
  "open",
  "assigned",
  "delivered",
  "revision_requested",
] as const;

export type CancellationPreview = {
  jobId: string;
  title: string;
  budgetPaise: number;
  workerName: string | null;
  quote: CancellationQuote;
  /** False when the job is already finished, cancelled or in dispute. The
   *  screen shows nothing rather than a quote nobody can act on. */
  offered: boolean;
  /** An open case beats a cancellation — the money is already frozen and a
   *  person is already reading it. */
  openDisputeId: string | null;
};

export async function loadCancellationPreview(
  supabase: ServerSupabaseClient,
  jobId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<CancellationPreview | null> {
  if (!UUID_PATTERN.test(jobId)) return null;

  const { data: job, error } = await supabase
    .from("jobs")
    .select(
      "id, client_id, title, status, budget_paise, deadline_at, assigned_at, assigned_worker_id",
    )
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!job || job.client_id !== clientId) return null;

  const [{ data: delivered, error: deliveryError }, { data: dispute, error: disputeError }] =
    await Promise.all([
      // Any attempt at all, not just the standing one. Spec §5's last row is
      // about whether work has ever been sent, and a superseded attempt was
      // still sent.
      supabase.from("job_deliveries").select("id").eq("job_id", jobId).limit(1),
      supabase
        .from("disputes")
        .select("id")
        .eq("job_id", jobId)
        .not("status", "in", "(resolved,closed)")
        .limit(1)
        .maybeSingle(),
    ]);

  if (deliveryError) throw new Error(`Could not check deliveries: ${deliveryError.message}`);
  if (disputeError) throw new Error(`Could not check disputes: ${disputeError.message}`);

  const workerName = job.assigned_worker_id
    ? await displayName(supabase, job.assigned_worker_id)
    : null;

  return {
    jobId: job.id,
    title: job.title?.trim() || "Untitled job",
    budgetPaise: job.budget_paise ?? 0,
    workerName,
    quote: quoteCancellation({
      budgetPaise: job.budget_paise ?? 0,
      timing: {
        assignedAt: job.assigned_at ? new Date(job.assigned_at) : null,
        deadlineAt: job.deadline_at ? new Date(job.deadline_at) : null,
        hasDelivery: (delivered ?? []).length > 0,
      },
      now,
    }),
    offered:
      (CANCELLABLE_STATUSES as readonly string[]).includes(job.status) && dispute === null,
    openDisputeId: dispute?.id ?? null,
  };
}

async function displayName(
  supabase: ServerSupabaseClient,
  profileId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("public_profiles")
    .select("display_name")
    .eq("profile_id", profileId)
    .maybeSingle();

  return data?.display_name ?? null;
}
