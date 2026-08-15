import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { PAYOUT_BATCH_WORKER_LIMIT } from "@/lib/constants/payouts";
import { serverEnv } from "@/lib/env";
import { closedCycleAt } from "@/lib/payouts/cycle";
import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * The twice-weekly payout run — spec §6.
 *
 * Runs daily and does two things, in this order:
 *
 *   1. `release_matured_earning_holds()` — the new client's 14-day chargeback
 *      window expiring. Daily, so a worker's dashboard stops saying "Held" on
 *      the day the fourteen days are up rather than on the next pay day.
 *   2. `build_payout_batch()` for the cycle that has most recently closed.
 *
 * Building daily rather than twice weekly is deliberate. The cutoff is computed
 * from the calendar, not from the day the cron happens to fire, so on the five
 * days a week with nothing new to close the build finds its batch already closed
 * and says so. What that buys is tolerance: a run missed on Thursday is caught
 * on Friday, and the only cost is a payout a day late instead of a cycle late.
 *
 * Locked down the same way the auto-accept sweep and the Razorpay webhook are —
 * a bearer token that is not derivable from anything else, compared in constant
 * time, and no token configured means no requests served at all. The stronger
 * guarantee is in the database though: `build_payout_batch()` refuses any cutoff
 * that is not midnight IST on a Thursday or a Monday, and refuses one that has
 * not arrived. This route cannot pay anyone early even if it is called every
 * second with a forged clock.
 *
 * Wire it at Vercel → Settings → Cron Jobs, or with the `crons` entry in
 * `vercel.json`, which schedules it for 01:00 IST — an hour after either
 * midnight cutoff, and a comfortable margin before the 11:00 IST pay run.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Constant-time bearer comparison. Same as the auto-accept sweep's. */
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
    console.error("[payouts] CRON_SECRET is not set; refusing every request.");
    return NextResponse.json({ ok: false }, { status: 503 });
  }

  if (!tokenMatches(cronSecret, request.headers.get("authorization"))) {
    console.error("[payouts] rejected a payout run with a bad token");
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createServiceRoleClient();

  // ---- the holds that have run out ----------------------------------------

  const { data: released, error: releaseError } = await admin.rpc(
    "release_matured_earning_holds",
  );

  if (releaseError) {
    // Not fatal: the builder calls this itself before it selects, so a failure
    // here delays a status label, not a payment.
    console.error(`[payouts] releasing matured holds failed: ${releaseError.message}`);
  } else if (released && released > 0) {
    console.log(`[payouts] released ${released} earning(s) from the new-client hold`);
  }

  // ---- the cycle that has closed ------------------------------------------

  const cycle = closedCycleAt(new Date());

  const { data, error } = await admin.rpc("build_payout_batch", {
    p_cutoff_at: cycle.cutoffAt.toISOString(),
    p_max_workers: PAYOUT_BATCH_WORKER_LIMIT,
  });

  if (error) {
    console.error(
      `[payouts] building the batch for ${cycle.cutoffAt.toISOString()} failed: ${error.message}`,
    );
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // A setof-returning function with exactly one row — see the note in CLAUDE.md
  // about why `.single()` is not chained onto these.
  const summary = data?.[0];

  if (!summary) {
    console.error("[payouts] the batch builder returned nothing");
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  console.log(
    `[payouts] cycle closing ${cycle.closesLabel} (${cycle.cutoffAt.toISOString()}) → ` +
      `pays ${cycle.paysLabel}: batch ${summary.batch_id} is ${summary.status}, ` +
      `${summary.payouts_created} payout(s) over ${summary.earnings_claimed} earning(s), ` +
      `${summary.total_paise} paise`,
  );

  // Every worker who was owed money and could not be paid is money sitting on
  // the platform with a name attached, so it is logged loudly rather than
  // counted quietly. Until KYC is built this is *all* of them — see the note on
  // `build_payout_batch` in migration 0031.
  if (summary.workers_skipped > 0) {
    console.warn(
      `[payouts] ${summary.workers_skipped} worker(s) holding ${summary.skipped_paise} paise ` +
        `have no verified payout destination and were rolled into the next cycle`,
    );
  }

  return NextResponse.json(
    {
      ok: true,
      cutoffAt: summary.cutoff_at,
      scheduledPayAt: summary.scheduled_pay_at,
      status: summary.status,
      payoutsCreated: summary.payouts_created,
      earningsClaimed: summary.earnings_claimed,
      totalPaise: summary.total_paise,
      workersSkipped: summary.workers_skipped,
      skippedPaise: summary.skipped_paise,
    },
    { status: 200 },
  );
}
