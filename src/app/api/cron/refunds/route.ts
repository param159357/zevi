import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { REFUND_BATCH_SIZE } from "@/lib/constants/refunds";
import { isRazorpayConfigured, serverEnv } from "@/lib/env";
import { drainRefunds } from "@/lib/refunds/drain";

/**
 * The refund run — spec §14.
 *
 * Every path that ends with a client getting money back — a cancellation inside
 * spec §5's tiers, a dispute refunded or split under spec §11 — writes a
 * `refunds` row and returns. This is what turns those rows into money, and the
 * separation is the point: a client pressing "cancel" waits on our database and
 * on nothing else, and Razorpay being slow or down for an hour costs a refund
 * that starts an hour later rather than a cancellation that failed halfway
 * through dividing escrow.
 *
 * Locked down like the payout run — a bearer token compared in constant time,
 * and no token configured means no requests served at all. The exposure is the
 * highest of the four crons: this is the one that sends money out of the
 * platform account. What stands behind the token is that the route decides
 * nothing. Every amount is read off a `refunds` row written under a job's row
 * lock by `request_job_cancellation()` or `resolve_dispute()`, and
 * `mark_refund_completed()` refuses to credit escrow more than the job has left
 * in it — so a forged call to this endpoint issues the refunds that were already
 * owed, faster, and cannot invent one.
 *
 * Every fifteen minutes in production, via `vercel.json`. A refund takes 5–7
 * working days to reach a bank; a quarter of an hour at the front of that is
 * not the part anybody notices, and it keeps a poll of a `pending` refund
 * cheap.
 *
 * Idempotent and safe to run twice at once — `claim_refund_batch()` locks with
 * `skip locked`, so two runs take different rows.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time bearer comparison. Same as the other three crons'. */
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
    console.error("[refunds] CRON_SECRET is not set; refusing every request.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  if (!tokenMatches(cronSecret, request.headers.get("authorization"))) {
    console.error("[refunds] rejected a refund run with a bad token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Nothing is claimed when there is no gateway to claim it for, which is the
  // opposite of what the outbox drain does with an unconfigured SES — and the
  // difference is that an email can be printed to a console and a refund cannot.
  // Claiming here would spend every row's attempts against a gateway that was
  // never going to be there and leave a queue of `failed` refunds that were
  // never actually refused. The rows keep, and 503 says the run did not happen.
  if (!isRazorpayConfigured()) {
    console.error("[refunds] Razorpay is not configured — no refund can be issued.");
    return NextResponse.json({ ok: false, reason: "gateway-unconfigured" }, { status: 503 });
  }

  let summary;
  try {
    summary = await drainRefunds(REFUND_BATCH_SIZE);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "unknown error";
    console.error(`[refunds] run failed: ${reason}`);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (summary.claimed > 0) {
    console.log(
      `[refunds] worked ${summary.claimed}: ${summary.submitted} submitted, ` +
        `${summary.completed} completed, ${summary.retrying} retrying, ${summary.failed} failed`,
    );
  }

  // A failed refund is a client who was told they would get their money back
  // and has not, with `escrow_holds.refunded_paise` already recording the
  // decision. There is no screen for this yet, so the log line is the alarm —
  // named at error level, and greppable.
  if (summary.failed > 0) {
    console.error(
      `[refunds] ${summary.failed} refund(s) gave up and need a person — see refunds.failure_reason`,
    );
  }

  // 200 even with failures: the run happened. A non-2xx would ask Vercel to
  // retry a run that has already recorded its outcomes row by row, and retrying
  // a run that sends money is the wrong instinct to build in.
  return NextResponse.json({ ok: true, ...summary }, { status: 200 });
}
