/**
 * Server-side reads for the two sides of a dispute — spec §11.
 *
 * Every query here runs under the caller's own Supabase client, so RLS is what
 * scopes it: `both sides read the dispute` (0015) returns nothing to anyone who
 * is not the client, the assigned worker or an admin, and `both sides read
 * statements` does the same through `is_dispute_party`. The explicit filters are
 * for the indexes and for readability; they are not what enforces anything.
 *
 * This module is deliberately not `lib/admin/disputes.ts` with a narrower SELECT
 * list. A participant's screen and a reviewer's screen answer different
 * questions from different tables — the reviewer reads the raw chat and both
 * private histories, which are gated on `view_disputes` and `manage_users` at
 * the table level. Two modules cannot leak into each other by someone adding a
 * column to a shared query.
 */

import { POST_ACCEPTANCE_HOURS } from "@/lib/constants/disputes";
import { createClient } from "@/lib/supabase/server";
import type { DisputeEligibility, DisputeView, PartyStatement } from "@/lib/disputes/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statuses a case can still be spoken to. */
const LIVE_STATUSES = ["open", "awaiting_response", "self_settlement", "admin_review", "appealed"];

/**
 * One case, as the client or the worker sees it.
 *
 * Returns null for anyone who is not a party, because RLS returned them nothing
 * — which is what a 404 on the page should be built from.
 */
export async function loadDisputeForParty(
  supabase: ServerSupabaseClient,
  disputeId: string,
  viewerId: string,
): Promise<DisputeView | null> {
  if (!UUID_PATTERN.test(disputeId)) return null;

  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      `id, job_id, raised_by, raised_by_role, status, reason_summary, amount_paise,
       opened_at, response_due_at, decision_due_at, outcome, split_client_bps,
       decision_note, decided_at, client_refund_cap_bps`,
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(`Could not load dispute ${disputeId}: ${error.message}`);
  if (!dispute) return null;

  const [{ data: job, error: jobError }, { data: statements, error: statementError }] =
    await Promise.all([
      supabase
        .from("jobs")
        .select("id, title, budget_paise, client_id, assigned_worker_id")
        .eq("id", dispute.job_id)
        .maybeSingle(),
      supabase
        .from("dispute_statements")
        .select("id, author_id, author_role, body, created_at")
        .eq("dispute_id", disputeId)
        .order("created_at", { ascending: true }),
    ]);

  if (jobError) throw new Error(`Could not load the disputed job: ${jobError.message}`);
  if (statementError) throw new Error(`Could not load statements: ${statementError.message}`);
  if (!job) return null;

  // Which side the viewer is. An admin reaching this page is neither, and gets
  // nothing — they have their own screen, with more on it.
  const viewerRole =
    job.client_id === viewerId
      ? ("client" as const)
      : job.assigned_worker_id === viewerId
        ? ("worker" as const)
        : null;

  if (!viewerRole) return null;

  const rows = statements ?? [];
  const names = await displayNames(
    supabase,
    rows.filter((row) => row.author_id !== viewerId).map((row) => row.author_id),
  );

  return {
    disputeId: dispute.id,
    jobId: dispute.job_id,
    jobTitle: job.title?.trim() || "Untitled job",
    status: dispute.status,
    outcome: dispute.outcome,
    splitClientBps: dispute.split_client_bps,
    decisionNote: dispute.decision_note,
    decidedAt: dispute.decided_at,
    reasonSummary: dispute.reason_summary,
    amountPaise: dispute.amount_paise,
    budgetPaise: job.budget_paise ?? 0,
    openedAt: dispute.opened_at,
    responseDueAt: dispute.response_due_at,
    decisionDueAt: dispute.decision_due_at,
    raisedByRole: dispute.raised_by_role,
    viewerRole,
    raisedByMe: dispute.raised_by === viewerId,
    clientRefundCapBps: dispute.client_refund_cap_bps,
    statements: rows.map(
      (row): PartyStatement => ({
        id: row.id,
        authorRole: row.author_role,
        authorName: names.get(row.author_id) ?? "The other side",
        body: row.body,
        isMine: row.author_id === viewerId,
        createdAt: row.created_at,
      }),
    ),
    // A second statement from the same side is allowed by the function but not
    // offered by the screen: spec §11 gives each side one, and a case that turns
    // into a thread is a case nobody can decide in three minutes.
    canRespond:
      LIVE_STATUSES.includes(dispute.status) &&
      dispute.outcome === null &&
      !rows.some((row) => row.author_id === viewerId),
  };
}

/** The live case on a job, if there is one — what turns a "Raise a dispute"
 *  button into a link to the case that already exists. */
export async function liveDisputeForJob(
  supabase: ServerSupabaseClient,
  jobId: string,
): Promise<{ disputeId: string; status: string } | null> {
  if (!UUID_PATTERN.test(jobId)) return null;

  const { data, error } = await supabase
    .from("disputes")
    .select("id, status")
    .eq("job_id", jobId)
    .not("status", "in", "(resolved,closed)")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Could not check disputes on ${jobId}: ${error.message}`);

  return data ? { disputeId: data.id, status: data.status } : null;
}

/** Every case this person is a party to, newest first. Both dashboards link
 *  into it, so it takes the viewer's id rather than a role. */
export async function loadDisputesForUser(
  supabase: ServerSupabaseClient,
  viewerId: string,
  limit = 20,
): Promise<{ disputeId: string; jobId: string; jobTitle: string; status: string; openedAt: string }[]> {
  // `both sides read the dispute` scopes this to jobs they are on, so no filter
  // on the viewer is needed — or possible, since either column could be them.
  const { data, error } = await supabase
    .from("disputes")
    .select("id, job_id, status, opened_at, jobs ( title, client_id, assigned_worker_id )")
    .order("opened_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load disputes: ${error.message}`);

  return (data ?? [])
    .filter(
      (row) =>
        row.jobs?.client_id === viewerId || row.jobs?.assigned_worker_id === viewerId,
    )
    .map((row) => ({
      disputeId: row.id,
      jobId: row.job_id,
      jobTitle: row.jobs?.title?.trim() || "Untitled job",
      status: row.status,
      openedAt: row.opened_at,
    }));
}

/**
 * Whether this person may open a case on this job right now, and who they are
 * on it — spec §11's two windows.
 *
 * A preview of what `open_dispute()` will decide, and only that: the function
 * checks all of it again under the job's row lock, and it is the one that
 * counts. This exists so the screen can offer a button or a sentence rather than
 * a button that turns into a sentence.
 */
export async function disputeEligibility(
  supabase: ServerSupabaseClient,
  jobId: string,
  viewerId: string,
): Promise<{
  jobId: string;
  jobTitle: string;
  viewerRole: "client" | "worker";
  otherPartyName: string;
  eligibility: DisputeEligibility;
  existingDisputeId: string | null;
} | null> {
  if (!UUID_PATTERN.test(jobId)) return null;

  const { data: job, error } = await supabase
    .from("jobs")
    .select("id, title, status, client_id, assigned_worker_id, assigned_at")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw new Error(`Could not load job ${jobId}: ${error.message}`);
  if (!job) return null;

  const viewerRole =
    job.client_id === viewerId
      ? ("client" as const)
      : job.assigned_worker_id === viewerId
        ? ("worker" as const)
        : null;

  if (!viewerRole) return null;

  const otherId = viewerRole === "client" ? job.assigned_worker_id : job.client_id;

  const [existing, otherName, { data: deliveries, error: deliveryError }, { data: earning }] =
    await Promise.all([
      liveDisputeForJob(supabase, jobId),
      otherId ? displayName(supabase, otherId) : Promise.resolve(null),
      supabase
        .from("job_deliveries")
        .select("id, status, accepted_at")
        .eq("job_id", jobId)
        .order("attempt", { ascending: false }),
      supabase.from("worker_earnings").select("status").eq("job_id", jobId).maybeSingle(),
    ]);

  if (deliveryError) throw new Error(`Could not load deliveries: ${deliveryError.message}`);

  const base = {
    jobId: job.id,
    jobTitle: job.title?.trim() || "Untitled job",
    viewerRole,
    otherPartyName:
      otherName ?? (viewerRole === "client" ? "the worker" : "the client"),
    existingDisputeId: existing?.disputeId ?? null,
  };

  if (existing) {
    return {
      ...base,
      eligibility: { canRaise: false, reason: "There is already an open case on this job." },
    };
  }

  const attempts = deliveries ?? [];

  if (viewerRole === "client") {
    // "Client window: delivery until 48h after acceptance."
    if (attempts.length === 0) {
      return {
        ...base,
        eligibility: {
          canRaise: false,
          reason:
            "Nothing has been delivered on this job yet, so there is nothing to dispute. You can cancel it instead.",
        },
      };
    }

    const accepted = attempts.find((row) => row.status === "accepted" && row.accepted_at);

    if (accepted?.accepted_at) {
      const closesAt = new Date(
        new Date(accepted.accepted_at).getTime() + POST_ACCEPTANCE_HOURS * 3_600_000,
      );

      if (Date.now() > closesAt.getTime()) {
        return {
          ...base,
          eligibility: {
            canRaise: false,
            reason: `The ${POST_ACCEPTANCE_HOURS} hours to raise a dispute after accepting this work have passed. Write to support if something is still wrong.`,
          },
        };
      }

      return {
        ...base,
        eligibility: {
          canRaise: true,
          deadlineNote: `You accepted this work, so you have until ${closesAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} to open a case.`,
        },
      };
    }

    return { ...base, eligibility: { canRaise: true, deadlineNote: null } };
  }

  // "Worker window: assignment until payout."
  if (!job.assigned_at) {
    return {
      ...base,
      eligibility: { canRaise: false, reason: "You are not assigned to this job." },
    };
  }

  if (earning && (earning.status === "in_payout" || earning.status === "paid")) {
    return {
      ...base,
      eligibility: {
        canRaise: false,
        reason:
          "You have already been paid for this job, so the dispute window has closed. Write to support.",
      },
    };
  }

  return { ...base, eligibility: { canRaise: true, deadlineNote: null } };
}

/** `public_profiles`, the projection every signed-in user may read. Neither
 *  party sees the other's legal name — the same rule the shortlist follows. */
async function displayNames(
  supabase: ServerSupabaseClient,
  profileIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(profileIds)];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase
    .from("public_profiles")
    .select("profile_id, display_name")
    .in("profile_id", unique);

  if (error) throw new Error(`Could not load names: ${error.message}`);

  return new Map((data ?? []).map((row) => [row.profile_id, row.display_name]));
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
