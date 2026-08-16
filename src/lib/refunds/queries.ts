/**
 * What a client can see about money coming back — spec §14.
 *
 * Read under the caller's own client, never the service-role one. `participants
 * read refunds` (0012) is what decides, and it is already the right policy: both
 * sides of a job may see that a refund exists, which matters on a dispute where
 * the worker's half of the decision is only half the story.
 *
 * Nothing here is admin-facing. `failure_reason` is a gateway message written
 * for a developer and it does not cross this boundary — what a client is told
 * about a failed refund is a sentence from `REFUND_STATUS_COPY`, not a
 * Razorpay error description.
 */

import type { RefundView } from "@/lib/refunds/types";
import { createClient } from "@/lib/supabase/server";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every refund on a job, newest first.
 *
 * A list rather than a single row because a job genuinely can have more than
 * one: 0036 writes one for a cancellation and one for a dispute, and a job that
 * was split and later appealed would carry both. Showing only the newest would
 * silently drop money somebody is owed.
 */
export async function loadJobRefunds(
  supabase: ServerSupabaseClient,
  jobId: string,
): Promise<RefundView[]> {
  if (!UUID_PATTERN.test(jobId)) return [];

  const { data, error } = await supabase
    .from("refunds")
    .select("id, amount_paise, reason, status, created_at, completed_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Could not load refunds for ${jobId}: ${error.message}`);

  return (data ?? []).map((refund) => ({
    id: refund.id,
    amountPaise: refund.amount_paise,
    reason: refund.reason,
    status: refund.status,
    createdAt: refund.created_at,
    completedAt: refund.completed_at,
  }));
}
