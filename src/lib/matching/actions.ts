"use server";

/**
 * Opting into a job — spec §6.
 *
 * Rules that hold everywhere below:
 *   * the worker is re-derived from the session on every call, never taken from
 *     the payload. A form that renders is not authorisation
 *   * the write goes through the worker's own Supabase client, so `approved
 *     workers opt into open jobs` (migration 0007) is what decides whether it
 *     lands: approved, active, the job open, the category theirs. None of those
 *     four facts is re-asserted here as a value — they are re-read as
 *     conditions, and the policy has the last word
 *   * the five-slot cap is checked here for the message and enforced by
 *     `sync_opt_in_counters()`, which recounts from `job_opt_ins` and raises.
 *     The pre-check is a courtesy; the trigger is the limit
 *   * every length rule has a CHECK behind it. The parsers turn a constraint
 *     violation into a sentence, they do not stand in for one
 */

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth/session";
import { WORKER_ROUTES } from "@/lib/constants/workers";
import { loadMatchingSettings, loadOptInCapacity } from "@/lib/matching/queries";
import type { OptInInput, OptInResult, SimpleResult } from "@/lib/matching/types";
import { parseOptInFields } from "@/lib/matching/validation";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A CHECK or a policy firing here is a bug in this file's validation, not
 * something the worker should read as prose — but they still need a sentence,
 * and the log still needs the original.
 */
function describeWriteError(error: { code?: string; message: string }): string {
  console.error(`[matching] opt-in failed ${error.code ?? "?"}: ${error.message}`);

  if (error.message.includes("at most")) {
    return "You're already holding as many opt-ins as you're allowed. Withdraw one first.";
  }
  // The dwell CHECK measures against the database's `now()`, which can land a
  // hair behind the clock this process checked. Reachable only at the exact
  // boundary, and the answer is genuinely "wait a moment".
  if (error.message.includes("job_opt_ins_dwell")) {
    return "That was a fraction too quick. Try again.";
  }
  if (error.code === "42501") {
    return "You can't opt into this job — check it's still open and in one of your categories.";
  }
  return "We couldn't send that. Try again.";
}

/**
 * Spec §6's 20-second dwell timer.
 *
 * `brief_opened_at` is stamped by the server that rendered the brief and posted
 * back by the browser, so a worker who edits the payload can shorten their own
 * wait. That is the schema's own reading of it — 0007 calls the column
 * "client-supplied and therefore advisory", and stores it so a worker who opts
 * into forty jobs in a minute is visible in the data rather than merely
 * suspected. Closing it properly needs a signed token or a server-side record
 * of the page view; neither exists yet, and neither is what the timer is for.
 * The timer is friction against a worker firing off opt-ins without reading,
 * and friction is what it stays.
 *
 * What is checked: a real timestamp, not in the future, and long enough ago.
 * The `job_opt_ins_dwell` CHECK backs the same rule against `now()`.
 */
function dwellSatisfied(briefOpenedAt: string, dwellSeconds: number): boolean {
  const opened = Date.parse(briefOpenedAt);
  if (Number.isNaN(opened)) return false;

  const elapsedSeconds = (Date.now() - opened) / 1_000;

  return elapsedSeconds >= dwellSeconds && elapsedSeconds >= 0;
}

export async function optIntoJob(input: OptInInput): Promise<OptInResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(input.jobId)) {
    return { ok: false, error: "That job doesn't exist." };
  }

  const fields = parseOptInFields(input);
  if (!fields.ok) return { ok: false, fieldErrors: fields.fieldErrors };

  const settings = await loadMatchingSettings(supabase);

  if (!dwellSatisfied(input.briefOpenedAt, settings.dwellSeconds)) {
    return {
      ok: false,
      error: `Give the brief ${settings.dwellSeconds} seconds before you opt in.`,
    };
  }

  // The trigger would refuse this anyway, and with a worse sentence. Reading
  // the count first also means the worker is told which limit they hit rather
  // than being handed a constraint name.
  const capacity = await loadOptInCapacity(supabase, context.user.id, settings.maxActiveOptIns);

  if (capacity.atCap) {
    return {
      ok: false,
      error: `You're holding ${capacity.used} opt-ins, which is the limit. Withdraw one to free a slot.`,
    };
  }

  const { error } = await supabase.from("job_opt_ins").insert({
    job_id: input.jobId,
    worker_id: context.user.id,
    software: fields.value.software,
    turnaround: fields.value.turnaround,
    noticed_detail: fields.value.noticed,
    brief_opened_at: input.briefOpenedAt,
  });

  if (error) {
    // 23505: the (job_id, worker_id) unique index. A second tab, or a double
    // submit that beat the disabled button — they are in either way.
    if (error.code === "23505") {
      return { ok: false, error: "You've already opted into this job." };
    }
    return { ok: false, error: describeWriteError(error) };
  }

  revalidatePath(WORKER_ROUTES.feed);
  revalidatePath(WORKER_ROUTES.job(input.jobId));
  revalidatePath(WORKER_ROUTES.optIns);

  return { ok: true };
}

/**
 * Freeing a slot. Only an 'active' opt-in: once a client has shortlisted
 * someone they are mid-decision, and quietly vanishing from that list is a
 * behaviour spec §6 has penalties for and no rule about — so it waits for one.
 *
 * The UPDATE policy pins the new status to 'withdrawn' and migration 0028 pins
 * the columns, so this statement is the only shape the database will take.
 */
export async function withdrawOptIn(optInId: string): Promise<SimpleResult> {
  const context = await requireRole("worker");
  const supabase = await createClient();

  if (!UUID_PATTERN.test(optInId)) return { ok: false, error: "That opt-in doesn't exist." };

  const { data, error } = await supabase
    .from("job_opt_ins")
    .update({ status: "withdrawn", withdrawn_at: new Date().toISOString() })
    .eq("id", optInId)
    .eq("worker_id", context.user.id)
    .eq("status", "active")
    .select("job_id")
    .maybeSingle();

  if (error) {
    console.error(`[matching] withdraw failed ${error.code ?? "?"}: ${error.message}`);
    return { ok: false, error: "We couldn't withdraw that. Try again." };
  }

  // No row: already withdrawn, already shortlisted, or never theirs. The policy
  // and the filters above make those indistinguishable from here, which is the
  // right amount to tell someone about a row that may not be theirs.
  if (!data) {
    return { ok: false, error: "That opt-in isn't open to withdraw." };
  }

  revalidatePath(WORKER_ROUTES.feed);
  revalidatePath(WORKER_ROUTES.job(data.job_id));
  revalidatePath(WORKER_ROUTES.optIns);

  return { ok: true };
}
