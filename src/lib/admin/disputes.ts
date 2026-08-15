/**
 * Server-side reads for the dispute queue (spec §7, §11).
 *
 * Spec §7 asks one screen per case to carry "brief, files, chat, both
 * statements, both histories". That is six tables joined around one row, and
 * the reason it is worth the round trips is in the same sentence: a reviewer who
 * has to open four screens to decide takes twenty minutes, and spec §11 budgets
 * three.
 *
 * Every read runs under the reviewer's own client. `admin_can('view_disputes')`
 * on `disputes`, `dispute_statements` and `message_raw`, and `is_admin()` on
 * `jobs`, `job_deliveries`, `messages` and `files`, are what scope them — the
 * filters below are for the indexes and for readability.
 *
 * Two deliberate choices about what a reviewer sees:
 *
 *   * **The raw chat, not the redacted one.** `messages.body` is what the two
 *     parties saw; `message_raw.body` is what was typed. A dispute about
 *     off-platform contact is unarguable from the second and invisible in the
 *     first, which is exactly why 0009 split them and gave `message_raw` to
 *     `view_disputes` alone.
 *   * **Both private histories, when the role can read them.**
 *     `user_private_stats` is gated on `manage_users`, not `view_disputes`, so a
 *     support account reviewing a case sees the public counters and nulls where
 *     the dispute rate would be. That is the gate working; the screen says so
 *     rather than rendering a zero.
 */

import { DELIVERY_BUCKET } from "@/lib/constants/deliveries";
import { REVIEW_URL_TTL_SECONDS } from "@/lib/constants/workers";
import { createClient } from "@/lib/supabase/server";
import { signStorageObjects } from "@/lib/uploads/sign";
import type {
  DisputeCase,
  DisputeFile,
  DisputeParty,
  DisputeQueueRow,
  DisputeStatement,
} from "@/lib/admin/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The statuses that still need a person. Matches `disputes_queue_idx`, which
 *  is partial on exactly these four. */
const LIVE_STATUSES = ["open", "awaiting_response", "admin_review", "appealed"] as const;

/**
 * The queue, ordered by what is closest to breaching its decision deadline —
 * spec §7's "ordered by what's rotting", and spec §11's five days.
 */
export async function loadDisputeQueue(
  supabase: ServerSupabaseClient,
  limit = 50,
): Promise<DisputeQueueRow[]> {
  const { data, error } = await supabase
    .from("disputes")
    .select(
      `id, job_id, raised_by, raised_by_role, status, layer, reason_summary,
       amount_paise, opened_at, response_due_at, first_response_due_at,
       first_responded_at, decision_due_at,
       jobs ( title )`,
    )
    .in("status", LIVE_STATUSES)
    .order("decision_due_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Could not load the dispute queue: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const names = await displayNames(
    supabase,
    rows.map((row) => row.raised_by),
  );

  return rows.map((row) => ({
    disputeId: row.id,
    jobId: row.job_id,
    jobTitle: row.jobs?.title?.trim() || "Untitled job",
    raisedByName: names.get(row.raised_by) ?? "Unknown",
    raisedByRole: row.raised_by_role,
    status: row.status,
    layer: row.layer,
    reasonSummary: row.reason_summary,
    amountPaise: row.amount_paise,
    openedAt: row.opened_at,
    firstResponseDueAt: row.first_response_due_at,
    firstRespondedAt: row.first_responded_at,
    decisionDueAt: row.decision_due_at,
  }));
}

/**
 * One case, whole.
 *
 * Reads that can run together do. The dispute row has to land first because
 * everything else is keyed off its `job_id`, but after that the brief, the
 * statements, the chat, the files and the two histories are independent.
 */
export async function loadDisputeCase(
  supabase: ServerSupabaseClient,
  disputeId: string,
): Promise<DisputeCase | null> {
  if (!UUID_PATTERN.test(disputeId)) return null;

  const { data: dispute, error } = await supabase
    .from("disputes")
    .select(
      `id, job_id, raised_by, raised_by_role, status, layer, reason_summary,
       amount_paise, opened_at, response_due_at, first_response_due_at,
       first_responded_at, decision_due_at, outcome, split_client_bps,
       decision_note, decided_at, client_refund_cap_bps`,
    )
    .eq("id", disputeId)
    .maybeSingle();

  if (error) throw new Error(`Could not load dispute ${disputeId}: ${error.message}`);
  if (!dispute) return null;

  const jobId = dispute.job_id;

  const [
    { data: job, error: jobError },
    { data: statements, error: statementError },
    { data: escrow, error: escrowError },
    { data: conversation, error: conversationError },
  ] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        `id, client_id, assigned_worker_id, title, description, status, budget_paise,
         deadline_at, delivered_at, categories ( name )`,
      )
      .eq("id", jobId)
      .maybeSingle(),
    supabase
      .from("dispute_statements")
      .select("id, author_id, author_role, body, is_appeal, created_at")
      .eq("dispute_id", disputeId)
      .order("created_at", { ascending: true }),
    supabase
      .from("escrow_holds")
      .select("amount_paise, status, released_paise, refunded_paise")
      .eq("job_id", jobId)
      .in("status", ["held", "frozen"])
      .maybeSingle(),
    supabase.from("conversations").select("id").eq("job_id", jobId).maybeSingle(),
  ]);

  if (jobError) throw new Error(`Could not load the disputed job: ${jobError.message}`);
  if (statementError) throw new Error(`Could not load statements: ${statementError.message}`);
  if (escrowError) throw new Error(`Could not load the escrow hold: ${escrowError.message}`);
  if (conversationError) {
    throw new Error(`Could not load the conversation: ${conversationError.message}`);
  }
  if (!job) return null;

  const [messages, files, client, worker, statementNames] = await Promise.all([
    conversation ? loadRawMessages(supabase, conversation.id) : Promise.resolve([]),
    loadCaseFiles(supabase, jobId),
    loadParty(supabase, job.client_id, "client"),
    job.assigned_worker_id
      ? loadParty(supabase, job.assigned_worker_id, "worker")
      : Promise.resolve(null),
    displayNames(supabase, (statements ?? []).map((row) => row.author_id)),
  ]);

  return {
    disputeId: dispute.id,
    jobId,
    jobTitle: job.title?.trim() || "Untitled job",
    jobDescription: job.description ?? "",
    jobStatus: job.status,
    categoryName: job.categories?.name ?? null,
    budgetPaise: job.budget_paise ?? 0,
    deadlineAt: job.deadline_at,
    deliveredAt: job.delivered_at,
    status: dispute.status,
    layer: dispute.layer,
    outcome: dispute.outcome,
    splitClientBps: dispute.split_client_bps,
    decisionNote: dispute.decision_note,
    decidedAt: dispute.decided_at,
    reasonSummary: dispute.reason_summary,
    amountPaise: dispute.amount_paise,
    openedAt: dispute.opened_at,
    firstResponseDueAt: dispute.first_response_due_at,
    decisionDueAt: dispute.decision_due_at,
    responseDueAt: dispute.response_due_at,
    raisedByRole: dispute.raised_by_role,
    escrowHeldPaise: escrow?.amount_paise ?? null,
    escrowStatus: escrow?.status ?? null,
    clientRefundCapBps: dispute.client_refund_cap_bps,
    client,
    worker,
    statements: (statements ?? []).map(
      (row): DisputeStatement => ({
        id: row.id,
        authorName: statementNames.get(row.author_id) ?? "Unknown",
        authorRole: row.author_role,
        body: row.body,
        isAppeal: row.is_appeal,
        createdAt: row.created_at,
      }),
    ),
    messages,
    files,
  };
}

/**
 * The chat as it was typed.
 *
 * `message_raw` carries the original body and `admin_can('view_disputes')` is
 * the only thing that reads it; `messages` carries the redaction count, which is
 * itself evidence — five redactions in a conversation is what an off-platform
 * contact case looks like from here.
 */
async function loadRawMessages(supabase: ServerSupabaseClient, conversationId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("id, sender_role, body, redaction_count, created_at, message_raw ( body )")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) throw new Error(`Could not load the conversation: ${error.message}`);

  return (data ?? []).map((row) => ({
    id: row.id,
    senderRole: row.sender_role,
    // The raw body when the role may read it, the redacted one when it may not.
    // A reviewer who cannot see through the masking still gets the shape of the
    // conversation, which is most of what a case turns on.
    body: row.message_raw?.body ?? row.body,
    redactionCount: row.redaction_count,
    createdAt: row.created_at,
  }));
}

/**
 * Everything either side put in front of the other, signed.
 *
 * The delivery files matter most and are the reason this is not a `files` query:
 * a reviewer needs the *delivered* work, not every object the worker ever
 * uploaded. Signed with the service-role key after the page's guard, exactly as
 * the approval queue signs samples — 0004's "a decision, not a row predicate".
 */
async function loadCaseFiles(
  supabase: ServerSupabaseClient,
  jobId: string,
): Promise<DisputeFile[]> {
  const [{ data: delivered, error: deliveryError }, { data: attached, error: attachError }] =
    await Promise.all([
      supabase
        .from("delivery_files")
        .select(
          "file_id, job_deliveries!inner ( job_id ), files ( id, storage_key, bucket, original_name, mime_type, size_bytes, purged_at )",
        )
        .eq("job_deliveries.job_id", jobId),
      supabase
        .from("job_attachments")
        .select(
          "file_id, files ( id, storage_key, bucket, original_name, mime_type, size_bytes, purged_at )",
        )
        .eq("job_id", jobId),
    ]);

  if (deliveryError) throw new Error(`Could not load delivered files: ${deliveryError.message}`);
  if (attachError) throw new Error(`Could not load job attachments: ${attachError.message}`);

  const rows = [
    ...(delivered ?? []).map((row) => ({ file: row.files, source: "delivery" as const })),
    ...(attached ?? []).map((row) => ({ file: row.files, source: "attachment" as const })),
  ].flatMap((row) =>
    row.file && row.file.purged_at === null ? [{ ...row, file: row.file }] : [],
  );

  if (rows.length === 0) return [];

  // Both prefixes live in the same private bucket today; `files.bucket` is what
  // will say otherwise the day R2 lands, so it is read rather than assumed.
  const byBucket = new Map<string, string[]>();
  for (const row of rows) {
    const bucket = row.file.bucket || DELIVERY_BUCKET;
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), row.file.storage_key]);
  }

  const signed = new Map<string, string>();
  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, keys]) => {
      const urls = await signStorageObjects(bucket, keys, REVIEW_URL_TTL_SECONDS);
      for (const [key, url] of urls) signed.set(key, url);
    }),
  );

  return rows.map((row) => ({
    id: row.file.id,
    name: row.file.original_name,
    mimeType: row.file.mime_type,
    sizeBytes: row.file.size_bytes,
    source: row.source,
    url: signed.get(row.file.storage_key) ?? null,
  }));
}

/**
 * One side's history.
 *
 * Public counters from the profile projections either party could see anyway,
 * and the private ones from `user_private_stats` — which is gated on
 * `manage_users`, a permission a dispute reviewer may not hold. A denial there
 * comes back as nulls rather than as a thrown error, because the case is still
 * decidable without them.
 */
async function loadParty(
  supabase: ServerSupabaseClient,
  profileId: string,
  role: "client" | "worker",
): Promise<DisputeParty | null> {
  const [{ data: identity }, { data: stats }] = await Promise.all([
    supabase
      .from("public_profiles")
      .select("display_name, member_since")
      .eq("profile_id", profileId)
      .maybeSingle(),
    supabase
      .from("user_private_stats")
      .select("disputes_raised, disputes_against, disputes_lost")
      .eq("profile_id", profileId)
      .maybeSingle(),
  ]);

  if (role === "client") {
    const { data: profile } = await supabase
      .from("client_profiles")
      .select("rating, rating_job_count, jobs_completed, jobs_cancelled")
      .eq("profile_id", profileId)
      .maybeSingle();

    return {
      profileId,
      displayName: identity?.display_name ?? "Unknown",
      role,
      jobsCompleted: profile?.jobs_completed ?? 0,
      jobsCancelled: profile?.jobs_cancelled ?? 0,
      rating: profile?.rating ?? null,
      ratingCount: profile?.rating_job_count ?? 0,
      memberSince: identity?.member_since ?? null,
      disputesRaised: stats?.disputes_raised ?? null,
      disputesAgainst: stats?.disputes_against ?? null,
      disputesLost: stats?.disputes_lost ?? null,
    };
  }

  const { data: profile } = await supabase
    .from("worker_profiles")
    .select("rating, rating_job_count, jobs_completed")
    .eq("profile_id", profileId)
    .maybeSingle();

  return {
    profileId,
    displayName: identity?.display_name ?? "Unknown",
    role,
    jobsCompleted: profile?.jobs_completed ?? 0,
    // Workers abandon rather than cancel, and that counter lives in
    // `worker_state` behind `manage_users`. Null says "not this side's number".
    jobsCancelled: null,
    rating: profile?.rating ?? null,
    ratingCount: profile?.rating_job_count ?? 0,
    memberSince: identity?.member_since ?? null,
    disputesRaised: stats?.disputes_raised ?? null,
    disputesAgainst: stats?.disputes_against ?? null,
    disputesLost: stats?.disputes_lost ?? null,
  };
}

/** `public_profiles`, the projection every signed-in user may read. A reviewer
 *  deciding a case has no need of the legal name in `profiles`. */
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
