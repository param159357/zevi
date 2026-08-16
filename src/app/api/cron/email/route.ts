import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { EMAIL_BATCH_SIZE } from "@/lib/constants/email";
import { drainOutbox } from "@/lib/email/outbox";
import { isEmailConfigured, serverEnv } from "@/lib/env";

/**
 * The outbox drain — spec §15.
 *
 * Everything on the platform that sends an email queues a row and returns.
 * This is what turns those rows into mail, and the separation is the point:
 * a client pressing "accept" waits on our database and on nothing else, and
 * Amazon being slow, throttling, or down for an hour costs a delayed email
 * rather than a failed acceptance.
 *
 * Locked down exactly like the auto-accept sweep and the payout run — a bearer
 * token compared in constant time, and no token means no requests served. The
 * exposure here is smaller than theirs (nothing moves money) but not nothing:
 * an open drain is a way to make the platform send a burst of real mail from a
 * verified domain, and a burst from a verified domain is how a sending
 * reputation gets spent.
 *
 * Every ten minutes in production, via `vercel.json`. That is the honest
 * resolution of this design: a receipt can be ten minutes late, which is the
 * price of not tying it to Amazon's availability. The reminders that need to
 * be timely are scheduled by the hourly sweep, which has an hour of slack in a
 * 36-hour window.
 *
 * Idempotent and safe to run twice at once — `claim_email_batch()` locks with
 * `skip locked`, so two drains take different rows.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time bearer comparison. Same as the other two crons'. */
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
    console.error("[email] CRON_SECRET is not set; refusing every request.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  if (!tokenMatches(cronSecret, request.headers.get("authorization"))) {
    console.error("[email] rejected a drain request with a bad token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Deliberately still drained when SES is unconfigured: in development that
  // prints each message to the console, which is how the queue gets exercised
  // before anybody owns a domain. In production `deliverEmail` throws
  // non-retryably and the rows land in `failed` — visible, rather than piling
  // up as `queued` behind a provider that was never going to be there.
  if (!isEmailConfigured()) {
    console.warn("[email] SES is not configured — see docs/email-setup.md");
  }

  let summary;
  try {
    summary = await drainOutbox(EMAIL_BATCH_SIZE);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    console.error(`[email] drain failed: ${reason}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (summary.claimed > 0) {
    console.log(
      `[email] drained ${summary.claimed}: ${summary.sent} sent, ` +
        `${summary.retrying} retrying, ${summary.failed} failed`,
    );
  }

  // A failed email is somebody not hearing from us, which spec §15 calls the
  // failure mode of the whole channel. Named at warning level so it is greppable
  // in the platform logs without opening the table.
  if (summary.failed > 0) {
    console.warn(`[email] ${summary.failed} message(s) gave up and are sitting in email_outbox`);
  }

  // 200 even with failures: the drain ran. A non-2xx would ask Vercel to retry
  // a run that has already recorded its outcomes row by row.
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
