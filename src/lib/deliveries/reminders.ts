/**
 * Spec §5's nudges: "reminders at 12h/30h and 24h/60h".
 *
 * Those four numbers are two rules — a third of the window, and five sixths of
 * it — applied to the two windows spec §5 sets (36 hours under ₹1,000, three
 * days at or above it). `AUTO_ACCEPT_REMINDER_FRACTIONS` is that pair, and it is
 * measured against the window *stored on the delivery row* rather than against
 * the settings, for the same reason `stamp_auto_accept_deadline()` stores it: a
 * client promised 36 hours gets 36 hours even if the setting moves, and their
 * reminders move with their promise.
 *
 * **Sent by the hourly sweep, not scheduled at delivery.** The alternative —
 * queueing two future-dated rows when the work arrives — needs every path that
 * ends the review early (acceptance, a revision, a dispute, a cancellation) to
 * remember to cancel them, and a missed cancellation is an email telling a
 * client to review something they already accepted. Reading the live rows once
 * an hour cannot go stale: a delivery that is no longer `pending_review` is
 * simply not in the result.
 *
 * The cost is up to an hour of drift on a 12-hour mark, which nobody has been
 * promised anything about.
 */

import {
  AUTO_ACCEPT_REMINDER_FRACTIONS,
  AUTO_ACCEPT_REMINDER_LIMIT,
} from "@/lib/constants/email";
import { JOB_ROUTES } from "@/lib/constants/jobs";
import { absoluteUrl } from "@/lib/email/links";
import { queueEmail } from "@/lib/email/outbox";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { formatRemaining, formatWhen, jobReference } from "@/lib/utils/format";

export type ReminderSummary = { queued: number; failed: number };

/** Which nudge is owed, if any. Null when it is too early, or both are sent. */
function reminderDue(
  delivery: {
    delivered_at: string;
    auto_accept_at: string;
    reminder_1_sent_at: string | null;
    reminder_2_sent_at: string | null;
  },
  now: number,
): 1 | 2 | null {
  const start = new Date(delivery.delivered_at).getTime();
  const end = new Date(delivery.auto_accept_at).getTime();
  const window = end - start;

  if (!Number.isFinite(window) || window <= 0) return null;

  const elapsed = (now - start) / window;

  // Checked second-mark first: a sweep that missed the first one entirely —
  // an outage, a delivery made 30 hours before the cron was fixed — should send
  // the useful reminder rather than the one whose moment has passed.
  if (elapsed >= AUTO_ACCEPT_REMINDER_FRACTIONS[1] && delivery.reminder_2_sent_at === null) {
    return 2;
  }
  if (elapsed >= AUTO_ACCEPT_REMINDER_FRACTIONS[0] && delivery.reminder_1_sent_at === null) {
    return 1;
  }

  return null;
}

/**
 * Queue the reminders that are due, and stamp the rows that got one.
 *
 * Queue first, stamp second. The dedupe key is the delivery and the reminder
 * number, so an enqueue that succeeds and a stamp that fails produce one email
 * and one retry next hour — not two emails. The other order would lose a
 * reminder entirely on the same failure.
 */
export async function sendAutoAcceptReminders(
  limit: number = AUTO_ACCEPT_REMINDER_LIMIT,
): Promise<ReminderSummary> {
  const admin = createServiceRoleClient();
  const now = Date.now();

  const { data: deliveries, error } = await admin
    .from("job_deliveries")
    // One string literal, not a concatenation: PostgREST's generated types are
    // inferred from the literal, and a `+` between two halves of it collapses
    // every row to `GenericStringError`.
    .select(
      "id, job_id, worker_id, delivered_at, auto_accept_at, reminder_1_sent_at, reminder_2_sent_at, jobs!inner(id, title, client_id)",
    )
    .eq("status", "pending_review")
    // The second reminder is the last one, so a row that has had it is done.
    .is("reminder_2_sent_at", null)
    .order("delivered_at")
    .limit(limit);

  if (error) {
    console.error(`[reminders] could not read pending deliveries: ${error.message}`);
    return { queued: 0, failed: 0 };
  }

  const due = (deliveries ?? [])
    .map((delivery) => ({ delivery, which: reminderDue(delivery, now) }))
    .filter((row): row is { delivery: (typeof row)["delivery"]; which: 1 | 2 } => row.which !== null);

  if (due.length === 0) return { queued: 0, failed: 0 };

  // One read for every name, rather than one per delivery. `public_profiles` is
  // the projection a client is allowed to see — the worker's display name, not
  // the legal name on their ID.
  const { data: names } = await admin
    .from("public_profiles")
    .select("profile_id, display_name")
    .in("profile_id", [...new Set(due.map((row) => row.delivery.worker_id))]);

  const displayName = new Map((names ?? []).map((row) => [row.profile_id, row.display_name]));

  const summary: ReminderSummary = { queued: 0, failed: 0 };

  for (const { delivery, which } of due) {
    const job = delivery.jobs;

    await queueEmail({
      template: "auto_accept_reminder",
      profileId: job.client_id,
      jobId: job.id,
      dedupeKey: `delivery:${delivery.id}:reminder:${which}`,
      payload: {
        jobRef: jobReference(job.id),
        jobTitle: job.title ?? "your job",
        workerName: displayName.get(delivery.worker_id) ?? "Your worker",
        remainingLabel: formatRemaining(delivery.auto_accept_at, new Date(now)),
        deadlineLabel: formatWhen(delivery.auto_accept_at),
        url: absoluteUrl(JOB_ROUTES.review(job.id)),
      },
    });

    const { error: stampError } = await admin
      .from("job_deliveries")
      .update(
        which === 1
          ? { reminder_1_sent_at: new Date(now).toISOString() }
          : { reminder_2_sent_at: new Date(now).toISOString() },
      )
      .eq("id", delivery.id);

    if (stampError) {
      // The email is queued and deduplicated, so the only cost of this is the
      // next sweep looking at the same row again.
      console.error(
        `[reminders] queued reminder ${which} for delivery ${delivery.id} but could not stamp it: ${stampError.message}`,
      );
      summary.failed += 1;
      continue;
    }

    summary.queued += 1;
  }

  return summary;
}
