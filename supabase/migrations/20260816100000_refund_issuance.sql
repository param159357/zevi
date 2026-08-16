-- ============================================================================
-- Zevi 0038 — refunds, actually issued
--
-- Every money path on this platform that ends with a client getting something
-- back has been writing the same row and stopping there: a `refunds` row in
-- `pending`, with a comment saying Razorpay's refund API is not wired. Migration
-- 0036 says it twice, once in `request_job_cancellation()` and once in
-- `resolve_dispute()`. This migration is the rest of that sentence.
--
-- The shape is 0037's, deliberately, because it is the same problem: an
-- external call that can fail, from a transaction that has already committed.
-- Nothing here sends anything. A `refunds` row *is* the queue — it always was,
-- which is why no new table appears below — and four functions move it:
--
--   claim_refund_batch()     what the drain works on, locked so two runs cannot
--   mark_refund_submitted()  Razorpay took the instruction but has not finished
--   mark_refund_completed()  the money left, and the ledger says so
--   mark_refund_failed()     it did not, and whether that is worth trying again
--
-- All four are service-role only, for the reason 0030's delivery functions and
-- 0037's outbox functions are: each moves a row the same statement cannot
-- finish, and `refunds` has had INSERT/UPDATE/DELETE revoked from
-- `authenticated` since 0012. A browser session has no business in a refund
-- queue, and the amount is never a parameter — it is read off the row that the
-- cancellation or the dispute decision wrote under the job's lock.
--
-- ### What the ledger says, and when
--
-- Capture (0029) debits escrow the budget and credits `external` the whole
-- charge. A cancellation or a dispute decision then credits escrow only the part
-- that actually moved — the worker's share and the ₹15 — and leaves the client's
-- share sitting in escrow, because it is genuinely still in the platform's
-- gateway account. That is the gap this migration closes: when Razorpay confirms
-- the money has gone,
--
--     credit  escrow    amount        the platform stops holding it
--     debit   external  amount        it went back the way it came
--
-- and the job's escrow balance reaches zero for the first time. Nothing is
-- written at submission — Razorpay accepting an instruction is not money
-- moving, and a ledger that records intentions is a ledger that disagrees with
-- the bank.
--
-- ### The gateway fee
--
-- Spec §14 has Zevi absorbing it rather than passing it on, and 0012 gave
-- `refunds` a column for it. No ledger entry is written for it here, and that is
-- not an omission: capture already debited `gateway_fees` and credited
-- `platform_revenue` for the whole fee, so the cost is recognised. Razorpay does
-- not return it on a refund. `gateway_fee_absorbed_paise` records the share of
-- that sunk fee attributable to the refunded amount, so "what did giving this
-- money back cost us" is answerable from the row rather than from arithmetic
-- somebody has to remember to do.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tunables
--
-- Same division 0037 has, and `lib/payouts/cycle.ts` has with
-- `build_payout_batch()`: the retry *schedule* is in TypeScript
-- (`lib/constants/refunds.ts`), the database keeps the invariant that nobody
-- retries for ever.
--
-- `refund.max_attempts` bounds *submissions*, not polls — see
-- `claim_refund_batch()` below for why those are counted differently.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('refund.max_attempts', '6', 'int',
   'Submissions to the gateway before a refund is left failed for a human.', false),
  ('refund.claim_stale_minutes', '15', 'int',
   'Minutes before a claimed refund is assumed abandoned and claimable again.', false),
  ('refund.poll_minutes', '30', 'int',
   'How long to wait before asking the gateway again about a submitted refund.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- The queue columns
--
-- `next_attempt_at` defaults to now(), which is what makes every `pending` row
-- 0036 has already written — and every one it writes from here on — due the
-- moment this migration lands. The two callers needed no change at all: they
-- were already inserting the instruction, and this is the reader arriving.
-- ----------------------------------------------------------------------------

alter table public.refunds
  add column if not exists attempts        integer not null default 0 check (attempts >= 0),
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists submitted_at    timestamptz;

comment on column public.refunds.attempts is
  'Gateway *submissions* made. Polls of an already-submitted refund do not count '
  'against it — the instruction is with Razorpay by then and giving up is not an option.';

comment on column public.refunds.submitted_at is
  'When Razorpay accepted the instruction. `completed_at` is when the money left.';

-- What the drain reads. Partial on the two live statuses, so the index stays
-- the size of the backlog rather than the size of the refund history.
create index if not exists refunds_due_idx on public.refunds (next_attempt_at)
  where status in ('pending', 'processing');

-- What a human reads. Spec §14 makes a refund a promise with a document behind
-- it, so one that gave up is a queue of its own, not a log line.
create index if not exists refunds_failed_idx on public.refunds (updated_at desc)
  where status = 'failed';

-- ----------------------------------------------------------------------------
-- claim_refund_batch
--
-- `for update skip locked`, so a slow run and a manual curl take different rows
-- instead of queueing behind each other — and, much more to the point here, so
-- two drains cannot both submit the same refund to Razorpay. Same shape as
-- `claim_email_batch()` and `sweep_auto_accepts()`.
--
-- Claiming pushes `next_attempt_at` forward by the stale window rather than
-- writing a `claimed_at` column: a drain that dies between the claim and the
-- outcome leaves a `processing` row that becomes due again on its own, with no
-- second timestamp to keep in agreement with the first.
--
-- **The attempt is counted at the claim, and only for a submission.** Counting
-- at the claim is 0037's rule and `open_worker_kyc_attempt()`'s before it: a
-- counter incremented on completion is a counter a crash escapes, and here what
-- it escapes into is repeated real refunds. Counting only when
-- `razorpay_refund_id is null` is this function's own rule, and it is the
-- important half. Before submission, an attempt is a thing that can be given up
-- on. After it, Razorpay holds the instruction and the only question left is
-- when it finishes — a poll that burned an attempt would mark a perfectly
-- healthy refund `failed` for the crime of taking a day.
-- ----------------------------------------------------------------------------

create or replace function public.claim_refund_batch(p_limit integer default 10)
returns table (
  id                  uuid,
  job_id              uuid,
  payment_id          uuid,
  razorpay_payment_id text,
  razorpay_refund_id  text,
  amount_paise        bigint,
  reason              text,
  note                text,
  attempts            integer,
  -- What the gateway kept on the capture, and what was charged, so the drain
  -- can work out the share of it this refund absorbs (spec §14) without a
  -- second round trip per row. None of the three decides what moves.
  charged_paise       bigint,
  gateway_fee_paise   bigint,
  gateway_tax_paise   bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale interval := make_interval(mins => public.setting_int('refund.claim_stale_minutes', 15));
begin
  -- A CTE the outer SELECT reads, rather than `return query update … returning`:
  -- the output columns of a `returns table` are plpgsql variables with the same
  -- names as the columns being written, and this keeps that ambiguity somewhere
  -- Postgres resolves rather than somewhere it guesses (0032).
  return query
  with claimed as (
    update public.refunds r
    set status          = 'processing'::public.refund_status,
        attempts        = r.attempts + case when r.razorpay_refund_id is null then 1 else 0 end,
        next_attempt_at = now() + v_stale
    where r.id in (
      select due.id
      from public.refunds due
      where due.status in ('pending'::public.refund_status, 'processing'::public.refund_status)
        and due.next_attempt_at <= now()
      order by due.next_attempt_at
      limit greatest(coalesce(p_limit, 10), 0)
      for update of due skip locked
    )
    -- RETURNING reads the whole row, not only the columns the SET touched, so
    -- `razorpay_refund_id` — the thing that decides submit versus poll — comes
    -- back from the same statement that claimed it rather than from a second
    -- read that a concurrent drain could have moved underneath.
    returning r.id, r.job_id, r.payment_id, r.razorpay_refund_id, r.amount_paise,
              r.reason, r.note, r.attempts, r.created_at
  )
  select c.id, c.job_id, c.payment_id, p.razorpay_payment_id, c.razorpay_refund_id,
         c.amount_paise, c.reason::text, c.note, c.attempts,
         p.amount_paise, p.gateway_fee_paise, p.gateway_tax_paise
  from claimed c
  join public.payments p on p.id = c.payment_id
  -- Oldest first. Ordering by `next_attempt_at` would be ordering by a column
  -- the update above just set to the same instant for every row in the batch.
  order by c.created_at;
end;
$$;

comment on function public.claim_refund_batch is
  'Refunds due for a gateway call, claimed with the submission attempt already '
  'counted. A row with a razorpay_refund_id is a poll, not a submission, and '
  'costs no attempt.';

-- ----------------------------------------------------------------------------
-- mark_refund_submitted
--
-- Razorpay answered, and answered `pending`: the instruction is accepted and the
-- money has not moved. Which is the ordinary case for a card refund and the
-- reason this state exists at all — the same asynchrony `lib/kyc/` handles for
-- the penny drop, and handled the same way, by writing down what we know and
-- coming back.
--
-- No ledger entry. Nothing has left the platform's account yet, and a ledger
-- that books an intention is one that disagrees with the bank statement on the
-- day somebody reconciles them.
-- ----------------------------------------------------------------------------

create or replace function public.mark_refund_submitted(
  p_id                 uuid,
  p_razorpay_refund_id text
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.refunds r
  set razorpay_refund_id = p_razorpay_refund_id,
      submitted_at       = coalesce(r.submitted_at, now()),
      status             = 'processing'::public.refund_status,
      failure_reason     = null,
      next_attempt_at    = now()
                           + make_interval(mins => public.setting_int('refund.poll_minutes', 30))
  where r.id = p_id
    and r.status <> 'completed'::public.refund_status;
$$;

-- ----------------------------------------------------------------------------
-- mark_refund_completed
--
-- The money has left. One transaction: the ledger, the payment's running total,
-- the refund row and the job's event trail.
--
-- Idempotent twice over, because this is the function a retried drain, a
-- duplicated cron and a future gateway webhook will all reach. The refund row is
-- locked and an already-`completed` one returns immediately; underneath that,
-- `ledger_transactions.idempotency_key` is keyed on the refund, which is the
-- same guard `settle_job_payment_and_assign()` relies on for the browser and the
-- webhook both settling a capture.
--
-- **It takes no amount.** Every figure comes from the `refunds` row that
-- `request_job_cancellation()` or `resolve_dispute()` wrote under the job's row
-- lock, off a frozen `job_financials`. There is no number in this signature for
-- a caller to get wrong, and the one thing a caller does supply — what the
-- gateway called the refund — cannot change what moves.
--
-- The escrow check is the belt under the braces. A job's escrow balance is what
-- the platform is still holding for it, and a refund can never credit more than
-- that. If the two ever disagree the honest thing is to stop: a refund issued
-- twice is real money gone and no amount of later reconciliation brings it back.
-- ----------------------------------------------------------------------------

create or replace function public.mark_refund_completed(
  p_id                 uuid,
  p_razorpay_refund_id text default null,
  p_gateway_fee_paise  bigint default 0
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund       public.refunds;
  v_payment      public.payments;
  v_txn_id       uuid;
  v_acct_escrow  uuid;
  v_acct_ext     uuid;
  v_escrow_bal   bigint;
  v_total        bigint;
begin
  -- Lock order is the refund, then the payment. It does not extend the jobs →
  -- payments order 0029 established because it never takes the jobs lock at
  -- all: the cancellation and dispute paths hold jobs and payments while they
  -- *insert* a refund row, and an insert takes no lock this function could be
  -- waiting on. No cycle, so no deadlock.
  select r.* into v_refund
  from public.refunds r
  where r.id = p_id
  for update;

  if v_refund.id is null then
    return 'not_found';
  end if;

  if v_refund.status = 'completed'::public.refund_status then
    return 'already_completed';
  end if;

  select p.* into v_payment
  from public.payments p
  where p.id = v_refund.payment_id
  for update;

  if v_payment.id is null then
    raise exception 'refund % points at payment %, which does not exist',
      p_id, v_refund.payment_id
      using errcode = 'no_data_found';
  end if;

  v_total := v_payment.refunded_paise + v_refund.amount_paise;

  if v_total > v_payment.amount_paise then
    raise exception 'refund % would take payment % past what was charged (% of %)',
      p_id, v_payment.id, v_total, v_payment.amount_paise
      using errcode = 'check_violation';
  end if;

  -- ---- the ledger ----------------------------------------------------------

  select a.id into v_acct_escrow from public.ledger_accounts a where a.code = 'escrow';
  select a.id into v_acct_ext    from public.ledger_accounts a where a.code = 'external';

  if v_acct_escrow is null or v_acct_ext is null then
    raise exception 'the platform ledger accounts are missing. Check migration 0018.'
      using errcode = 'no_data_found';
  end if;

  -- Debit-positive, per `ledger_account_balances`: what is left of this job's
  -- escrow after the worker's share and the fee were credited out of it.
  select coalesce(sum(e.amount_paise) filter (where e.direction = 'debit'), 0)
       - coalesce(sum(e.amount_paise) filter (where e.direction = 'credit'), 0)
    into v_escrow_bal
  from public.ledger_entries e
  where e.account_id = v_acct_escrow
    and e.job_id = v_refund.job_id;

  if v_refund.amount_paise > v_escrow_bal then
    raise exception
      'refund % is % paise but job % has only % left in escrow — refusing to double-refund',
      p_id, v_refund.amount_paise, v_refund.job_id, v_escrow_bal
      using errcode = 'check_violation';
  end if;

  insert into public.ledger_transactions (
    kind, job_id, reference_type, reference_id, description, idempotency_key, created_by
  )
  values (
    'refund_issued'::public.ledger_txn_kind, v_refund.job_id, 'refund', p_id,
    'Refund ' || v_refund.reason::text || ' returned to the client',
    -- Keyed on the refund, not the job: 0036 can write one refund row per
    -- cancellation and one per dispute, and a job that was split then appealed
    -- would have two legitimate ones.
    'refund_issued:' || p_id::text,
    v_refund.initiated_by
  )
  on conflict (idempotency_key) do nothing
  returning id into v_txn_id;

  if v_txn_id is not null then
    insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
    values (v_txn_id, v_acct_escrow, 'credit'::public.ledger_direction,
            v_refund.amount_paise, v_refund.job_id);

    insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
    values (v_txn_id, v_acct_ext, 'debit'::public.ledger_direction,
            v_refund.amount_paise, v_refund.job_id);

    -- ---- the payment -------------------------------------------------------
    --
    -- `partially_refunded` is the honest answer on almost every refund this
    -- platform issues, and it is worth knowing why rather than reading it as a
    -- rounding problem. What is charged is budget + the client's commission +
    -- GST; what is in escrow, and therefore what comes back, is the budget.
    -- Whether a client who wins gets the commission back is a question spec §8
    -- and §14 do not answer, so it is left open rather than answered here.

    update public.payments p
    set refunded_paise = v_total,
        status = case
          when v_total >= p.amount_paise then 'refunded'::public.payment_status
          else 'partially_refunded'::public.payment_status
        end
    where p.id = v_payment.id;
  end if;

  -- ---- the refund ----------------------------------------------------------

  update public.refunds r
  set status                     = 'completed'::public.refund_status,
      completed_at               = now(),
      razorpay_refund_id         = coalesce(p_razorpay_refund_id, r.razorpay_refund_id),
      submitted_at               = coalesce(r.submitted_at, now()),
      gateway_fee_absorbed_paise = greatest(coalesce(p_gateway_fee_paise, 0), 0),
      failure_reason             = null
  where r.id = p_id;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    v_refund.job_id, v_refund.initiated_by, 'system'::public.party_role, 'job.refunded',
    jsonb_build_object(
      'refund_id',    p_id,
      'amount_paise', v_refund.amount_paise,
      'reason',       v_refund.reason::text,
      'gateway_id',   coalesce(p_razorpay_refund_id, v_refund.razorpay_refund_id)
    )
  );

  return 'completed';
end;
$$;

comment on function public.mark_refund_completed is
  'The gateway confirmed the money left: credits escrow, debits external, moves '
  'payments.refunded_paise and closes the refund. Takes no amount — every figure '
  'is read off the refunds row. Idempotent on the row lock and on the ledger key.';

-- ----------------------------------------------------------------------------
-- mark_refund_failed
--
-- `p_retry_at` null means the caller has decided this is not worth trying again
-- — the gateway refused on the merits, and six identical refusals are six log
-- lines. A timestamp means it was transient.
--
-- Either way the ceiling wins: past `refund.max_attempts` the row is `failed`
-- however politely the drain asks. Same relationship `mark_email_failed()` has
-- with `email.max_attempts`, and `build_payout_batch()` has with the payout
-- calendar — the schedule is the caller's, the invariant is the database's.
--
-- A `failed` refund is money a client was told they would get and has not, with
-- `escrow_holds.refunded_paise` already recording the decision. Nothing here
-- unwinds that, because nothing should: the decision stands and it is the
-- payment that has to be made to work. `refunds_failed_idx` is what makes the
-- pile visible, and the drain shouts about it every run.
-- ----------------------------------------------------------------------------

create or replace function public.mark_refund_failed(
  p_id       uuid,
  p_error    text,
  p_retry_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_refund public.refunds;
  v_max    integer := public.setting_int('refund.max_attempts', 6);
  v_status public.refund_status;
begin
  select r.* into v_refund
  from public.refunds r
  where r.id = p_id
  for update;

  if v_refund.id is null then
    return null;
  end if;

  -- A completed refund cannot fail afterwards. A poll that raced the completion
  -- is the plausible way here, and the money has already gone.
  if v_refund.status = 'completed'::public.refund_status then
    return 'completed';
  end if;

  v_status := case
    when p_retry_at is null or v_refund.attempts >= v_max
      then 'failed'::public.refund_status
    else 'pending'::public.refund_status
  end;

  update public.refunds r
  set status          = v_status,
      failure_reason  = left(coalesce(p_error, 'unknown'), 2000),
      next_attempt_at = case
        when v_status = 'pending'::public.refund_status then p_retry_at
        else r.next_attempt_at
      end
  where r.id = p_id;

  return v_status::text;
end;
$$;

-- ----------------------------------------------------------------------------
-- The two comments 0036 left behind
--
-- Both functions said the gateway call was not wired. It is now, so they say
-- what they actually do: write the instruction, and let the drain carry it out.
-- Migrations are forward-only, so this is where that correction goes.
-- ----------------------------------------------------------------------------

comment on function public.request_job_cancellation is
  'Spec §5''s cancellation tiers, applied in one transaction: escrow divided, '
  'the worker''s share and the fee through the ledger, the client''s refund '
  'written as a pending `refunds` row for the drain (0038) to issue. A late '
  'request opens a capped dispute instead and returns its id.';

comment on function public.resolve_dispute is
  'Spec §11''s three outcomes, decided by a person. Moves the worker''s share '
  'through the ledger, writes the client''s as a pending `refunds` row for the '
  'drain (0038), and refuses a job whose escrow has already been released.';

-- ----------------------------------------------------------------------------
-- Grants
--
-- Service-role only, all four. `authenticated` has had INSERT/UPDATE/DELETE on
-- `refunds` revoked since 0012 and must not get there through a function either
-- — `mark_refund_completed()` writes the ledger, and `claim_refund_batch()` is
-- the thing that decides what gets sent to a payment gateway.
-- ----------------------------------------------------------------------------

revoke execute on function public.claim_refund_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_refund_batch(integer) to service_role;

revoke execute on function public.mark_refund_submitted(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_refund_submitted(uuid, text) to service_role;

revoke execute on function public.mark_refund_completed(uuid, text, bigint)
  from public, anon, authenticated;
grant execute on function public.mark_refund_completed(uuid, text, bigint) to service_role;

revoke execute on function public.mark_refund_failed(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_refund_failed(uuid, text, timestamptz) to service_role;
