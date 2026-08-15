/**
 * Server-side reads for the Payouts module (spec §7).
 *
 * "Escrow balance, batch review before each run, failed-payout queue with
 * retry."
 *
 * Three reads, and the first is the one that decides whether the other two can
 * be trusted: the escrow balance comes from `ledger_account_balances`, summed
 * from entries, never from a column. 0011 is explicit that a stored balance some
 * code path forgot to update cannot answer the question a chargeback asks six
 * months later, and an admin screen quoting one would be the first place that
 * rot became invisible.
 *
 * Everything here runs under the reviewer's own client. `manage_payouts` scopes
 * `payouts`, `payout_items` and `payout_methods`; `view_finance` scopes the
 * ledger and `worker_earnings`. The two are separate permissions on purpose —
 * the seeded `finance` role holds both, but a payouts operator who should not
 * read the whole ledger can be given only the first.
 */

import { createClient } from "@/lib/supabase/server";
import type {
  FailedPayoutRow,
  FinanceSnapshot,
  PayoutBatchDetail,
  PayoutBatchRow,
  PayoutLine,
} from "@/lib/admin/types";

type ServerSupabaseClient = Awaited<ReturnType<typeof createClient>>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The money, as the ledger has it, plus the two numbers that say what the next
 * run will and will not be able to pay.
 *
 * `blockedOnKycPaise` is the one worth having on screen: `build_payout_batch()`
 * skips any worker with no verified `payout_methods` row and leaves their
 * earnings `confirmed` for the next cycle, so this is the money that is ready
 * and has nowhere to go. Before KYC existed that was every rupee; now it is a
 * queue length.
 */
export async function loadFinanceSnapshot(
  supabase: ServerSupabaseClient,
): Promise<FinanceSnapshot> {
  const [{ data: balances }, { data: earnings }, { data: methods }] = await Promise.all([
    supabase.from("ledger_account_balances").select("type, balance_paise"),
    supabase
      .from("worker_earnings")
      .select("worker_id, net_paise")
      .eq("status", "confirmed")
      .is("payout_id", null),
    supabase
      .from("payout_methods")
      .select("worker_id")
      .eq("status", "verified")
      .is("disabled_at", null),
  ]);

  // Both columns are nullable on the view — it left-joins entries onto accounts,
  // so an account nobody has posted to yet comes back with a null balance and
  // that is a zero, not a gap.
  const totals = new Map<string, number>();
  for (const row of balances ?? []) {
    if (!row.type) continue;
    totals.set(row.type, (totals.get(row.type) ?? 0) + Number(row.balance_paise ?? 0));
  }

  const payable = new Set((methods ?? []).map((row) => row.worker_id));

  let awaiting = 0;
  let blocked = 0;

  for (const earning of earnings ?? []) {
    awaiting += earning.net_paise;
    if (!payable.has(earning.worker_id)) blocked += earning.net_paise;
  }

  return {
    // Debit-positive, per the view's own comment. Escrow and worker payable
    // should never go negative; if one does, that is the number to show.
    escrowPaise: totals.get("escrow") ?? 0,
    workerPayablePaise: totals.get("worker_payable") ?? 0,
    platformRevenuePaise: totals.get("platform_revenue") ?? 0,
    taxPayablePaise: totals.get("tax_payable") ?? 0,
    awaitingPayoutPaise: awaiting,
    blockedOnKycPaise: blocked,
  };
}

/** Batches, newest pay date first. `closed` is the one waiting on a person. */
export async function loadPayoutBatches(
  supabase: ServerSupabaseClient,
  limit = 20,
): Promise<PayoutBatchRow[]> {
  const { data, error } = await supabase
    .from("payout_batches")
    .select(
      "id, cutoff_at, scheduled_pay_at, status, total_paise, item_count, reviewed_at, failure_note, payouts ( id )",
    )
    .order("scheduled_pay_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Could not load payout batches: ${error.message}`);

  return (data ?? []).map(toBatchRow);
}

function toBatchRow(row: {
  id: string;
  cutoff_at: string;
  scheduled_pay_at: string;
  status: string;
  total_paise: number;
  item_count: number;
  reviewed_at: string | null;
  failure_note: string | null;
  payouts: { id: string }[] | null;
}): PayoutBatchRow {
  return {
    id: row.id,
    cutoffAt: row.cutoff_at,
    scheduledPayAt: row.scheduled_pay_at,
    status: row.status,
    totalPaise: row.total_paise,
    // `item_count` counts earnings, not workers. Spec §7's reviewer wants both:
    // "480 earnings across 96 workers" is a sane batch and "480 across 2" is
    // not, and neither number says that alone.
    itemCount: row.item_count,
    payoutCount: row.payouts?.length ?? 0,
    reviewedAt: row.reviewed_at,
    failureNote: row.failure_note,
  };
}

/**
 * One batch and every worker in it — the screen spec §7 means by "batch review
 * before each run".
 *
 * The destination is shown masked, and there is nothing to unmask: 0033 keeps
 * only `*_last4` and a keyed HMAC, so this is the whole of what exists. What a
 * reviewer is actually checking is that a verified destination is attached at
 * all, and when it was verified.
 */
export async function loadPayoutBatch(
  supabase: ServerSupabaseClient,
  batchId: string,
): Promise<PayoutBatchDetail | null> {
  if (!UUID_PATTERN.test(batchId)) return null;

  const { data: batch, error } = await supabase
    .from("payout_batches")
    .select(
      "id, cutoff_at, scheduled_pay_at, status, total_paise, item_count, reviewed_at, failure_note, payouts ( id )",
    )
    .eq("id", batchId)
    .maybeSingle();

  if (error) throw new Error(`Could not load batch ${batchId}: ${error.message}`);
  if (!batch) return null;

  const { data: payouts, error: payoutError } = await supabase
    .from("payouts")
    .select(
      `id, worker_id, amount_paise, status, failure_reason,
       payout_methods ( type, upi_handle_masked, account_last4, bank_name, verified_at ),
       payout_items ( id )`,
    )
    .eq("batch_id", batchId)
    .order("amount_paise", { ascending: false });

  if (payoutError) throw new Error(`Could not load batch lines: ${payoutError.message}`);

  const rows = payouts ?? [];
  const names = await displayNames(
    supabase,
    rows.map((row) => row.worker_id),
  );

  return {
    ...toBatchRow(batch),
    lines: rows.map(
      (row): PayoutLine => ({
        payoutId: row.id,
        workerId: row.worker_id,
        workerName: names.get(row.worker_id) ?? "Unnamed worker",
        amountPaise: row.amount_paise,
        status: row.status,
        itemCount: row.payout_items?.length ?? 0,
        destination: describeDestination(row.payout_methods),
        destinationVerifiedAt: row.payout_methods?.verified_at ?? null,
        failureReason: row.failure_reason,
      }),
    ),
  };
}

function describeDestination(
  method: {
    type: string;
    upi_handle_masked: string | null;
    account_last4: string | null;
    bank_name: string | null;
  } | null,
): string | null {
  if (!method) return null;

  if (method.type === "upi") return method.upi_handle_masked ?? "UPI";

  return (
    [method.bank_name, method.account_last4 ? `••${method.account_last4}` : null]
      .filter(Boolean)
      .join(" ")
      .trim() || "Bank account"
  );
}

/**
 * Spec §14's failed-payout queue.
 *
 * Empty until the disbursement step exists, because nothing can fail before
 * anything is attempted. It is here anyway rather than after: `retry_failed_payout()`
 * is what returns the money to the next cycle, and a queue nobody can see is
 * how a worker waits a fortnight for a transfer that failed on day one.
 */
export async function loadFailedPayouts(
  supabase: ServerSupabaseClient,
  limit = 50,
): Promise<FailedPayoutRow[]> {
  const { data, error } = await supabase
    .from("payouts")
    .select(
      `id, worker_id, amount_paise, attempt, failure_code, failure_reason, failed_at,
       payout_batches ( scheduled_pay_at )`,
    )
    .eq("status", "failed")
    .order("failed_at", { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Could not load failed payouts: ${error.message}`);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const names = await displayNames(
    supabase,
    rows.map((row) => row.worker_id),
  );

  return rows.map((row) => ({
    payoutId: row.id,
    workerId: row.worker_id,
    workerName: names.get(row.worker_id) ?? "Unnamed worker",
    amountPaise: row.amount_paise,
    attempt: row.attempt,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    failedAt: row.failed_at,
    batchPayAt: row.payout_batches?.scheduled_pay_at ?? null,
  }));
}

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

  if (error) throw new Error(`Could not load worker names: ${error.message}`);

  return new Map((data ?? []).map((row) => [row.profile_id, row.display_name]));
}
