import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { AUTO_ACCEPT_SWEEP_LIMIT } from "@/lib/constants/deliveries";
import { sendAutoAcceptReminders } from "@/lib/deliveries/reminders";
import { notifyJobCompleted } from "@/lib/email/events";
import { serverEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * Spec §4, step 9: "auto-accept fires if the client goes silent."
 *
 * This is the only thing on the platform that moves money without a person
 * asking it to, which is the whole reason it exists — a client who stops
 * replying must not be able to strand a worker's payment indefinitely — and also
 * the reason it is locked down as tightly as the payment webhook:
 *
 *   * a bearer token that is not derivable from anything else, compared in
 *     constant time, and no token means no requests served at all
 *   * every decision is `accept_job_delivery()`'s, called with `p_auto`, which
 *     re-checks `now() >= auto_accept_at` under the job's row lock. This route
 *     cannot accept anything early even if it is called every second
 *   * `sweep_auto_accepts()` gives each delivery its own subtransaction, so one
 *     job that cannot complete does not strand the ones behind it
 *
 * Wire it at Vercel → Settings → Cron Jobs, or with the `crons` entry in
 * `vercel.json`. Hourly is enough: the windows are 36 hours and 3 days, so an
 * hour of drift past the deadline is not a promise broken to anybody. Nothing
 * bad happens if it runs more often, or twice at once — the row lock and the
 * `already accepted` early return handle both.
 *
 * It also sends spec §5's reminders, at 12h/30h and 24h/60h — a third and five
 * sixths of whichever window the delivery was given. They belong on this
 * schedule rather than on their own because they are the same rows an hour
 * earlier in their life, and because reading the live rows is what keeps a
 * reminder from outliving the acceptance that made it wrong. See
 * `lib/deliveries/reminders.ts`.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time bearer comparison. Mirrors `digestsMatch` in the payment
 *  signature module — same reasoning, and it costs one function. */
function tokenMatches(expected: string, received: string | null): boolean {
  if (received === null) return false;

  const expectedBytes = Buffer.from(`Bearer ${expected}`, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");

  if (expectedBytes.length !== receivedBytes.length) return false;

  return timingSafeEqual(expectedBytes, receivedBytes);
}

export async function GET(request: Request): Promise<NextResponse> {
  let cronSecret: string;
  try {
    cronSecret = serverEnv.cronSecret;
  } catch {
    console.error("[auto-accept] CRON_SECRET is not set; refusing every request.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  if (!tokenMatches(cronSecret, request.headers.get("authorization"))) {
    console.error("[auto-accept] rejected a sweep request with a bad token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createServiceRoleClient();

  const { data, error } = await admin.rpc("sweep_auto_accepts", {
    p_limit: AUTO_ACCEPT_SWEEP_LIMIT,
  });

  if (error) {
    console.error(`[auto-accept] sweep failed: ${error.message}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const results = data ?? [];
  const accepted = results.filter((row) => row.accepted);
  const failed = results.filter((row) => !row.accepted);

  // A delivery whose window has expired and which cannot be completed is a
  // worker not being paid, so each one is named rather than counted.
  for (const row of failed) {
    console.error(
      `[auto-accept] delivery ${row.delivery_id} on job ${row.job_id} did not accept: ${row.detail}`,
    );
  }

  if (accepted.length > 0) {
    console.log(`[auto-accept] accepted ${accepted.length} delivery(s)`);
  }

  // A client whose window ran out is the one who most needs telling: they did
  // not press anything, and spec §12 removes the files seven days from now.
  for (const row of accepted) {
    await notifyJobCompleted({ jobId: row.job_id, autoAccepted: true });
  }

  // After the sweep, not before: a delivery whose window has just expired has
  // been accepted by the loop above and is no longer `pending_review`, so it
  // cannot be reminded about a decision it no longer has.
  const reminders = await sendAutoAcceptReminders();

  if (reminders.queued > 0) {
    console.log(`[auto-accept] queued ${reminders.queued} review reminder(s)`);
  }

  // 200 even with failures: the sweep itself ran. A non-2xx would say the run
  // needs retrying, and re-running it will fail on the same rows in the same
  // way — they need a person, not another attempt.
  return NextResponse.json(
    {
      ok: true,
      swept: results.length,
      accepted: accepted.length,
      failed: failed.length,
      remindersQueued: reminders.queued,
    },
    { status: 200 },
  );
}
