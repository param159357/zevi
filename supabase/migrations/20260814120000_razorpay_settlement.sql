-- ============================================================================
-- Zevi 0029 — payment at selection: order, capture, escrow, ledger, assignment
--
-- Spec §4 puts the charge at one exact moment: "client picks one, payment
-- happens here, into escrow". Until now selection assigned a job with a null
-- `payment_id` and nothing behind it. This migration is the money.
--
-- Three functions, and the split between them is the whole design:
--
--   open_job_payment()             service_role only. Freezes the price and
--                                  opens a payment row, before a rupee moves.
--   settle_job_payment_and_assign() service_role only. Everything that happens
--                                  once Razorpay has the money — in ONE
--                                  transaction, because a captured payment with
--                                  no assignment is a client charged for
--                                  nothing, and an assignment with no ledger
--                                  entries is a worker owed money nobody can
--                                  account for.
--   fail_job_payment()             service_role only. The other ending.
--
-- Why service_role and not the client's own key, when `claim_job_assignment`
-- deliberately runs as the caller: selection is now a money-moving write, and
-- this schema already has a rule for those — INSERT is revoked from
-- `authenticated` on `payments`, `escrow_holds`, `job_financials` and every
-- `ledger_*` table, and they are written server-side in the same transaction as
-- their ledger entries. Exposing settlement to `authenticated` would also hand
-- the browser the *timing* of it, and "assign the job while the money is only
-- authorised" is a real position to be left in. So the caller is named in
-- `p_actor_id`, checked against `jobs.client_id` under the lock, and recorded on
-- the `job.paid` event. The client is still who did it; they are no longer who
-- executes it.
--
-- ---------------------------------------------------------------------------
-- Where the money goes, in ledger terms
--
-- The client pays budget + their commission + GST on it. That splits three ways
-- the moment it is captured:
--
--   escrow            += budget            held for the worker, released on
--                                          acceptance, refundable on cancellation
--   platform_revenue  += client commission earned now — the client's half
--   tax_payable       += client GST        collected, owed onward, never revenue
--
-- The worker's own commission is NOT recognised here. It comes out of escrow
-- when escrow releases, because that is when it is earned. Spec §8's "Zevi
-- gross" is therefore realised across two moments, and this is the first.
--
-- The gateway fee is a second pair of legs in the same transaction: Razorpay's
-- cut is a cost against revenue, and `payments.gateway_fee_paise` is the real
-- figure off the payment entity, not the ≈2.36% estimate in spec §8.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Which worker the client was paying to hire
--
-- A webhook that lands after the client closed the tab carries the payment and
-- nothing else. Razorpay's `notes` hold the opt-in too, but notes make the round
-- trip through the browser's gateway session and are a hint for finding a row,
-- never a claim a row has to believe. This column is written by us, before the
-- charge, and is what settlement actually reads.
-- ----------------------------------------------------------------------------

alter table public.payments
  add column opt_in_id uuid references public.job_opt_ins (id) on delete restrict;

comment on column public.payments.opt_in_id is
  'The opt-in this payment was raised to hire. Set at order creation; what settlement assigns against.';

create index payments_opt_in_idx on public.payments (opt_in_id) where opt_in_id is not null;

-- One live payment attempt per job. A second order opened while one is
-- authorised is the shape a double charge arrives in, and the functions below
-- refuse it — this index means a race between two of them cannot slip past.
create unique index payments_one_live_per_job_idx on public.payments (job_id)
  where status in ('created', 'authorized');

-- ============================================================================
-- claim_job_assignment — the same enum-literal bug 0025 and 0026 fixed
--
-- 0025 fixed it in `publish_job()`, 0026 in `log_job_status_change()`. This
-- function has it twice and has never been corrected, because nothing had
-- reached the end of it: assignment is the last step of a flow whose first step
-- (posting) was itself broken until 0025.
--
--     case when caller = target.client_id then 'client'
--          when caller is null then 'system'
--          else 'admin' end
--
-- Every branch is a bare literal, so the CASE has nothing to resolve against
-- and comes out `text`. `job_events.actor_role` is `public.party_role`, and
-- Postgres will not coerce text to an enum in assignment context:
--
--     column "actor_role" is of type public.party_role but expression is of
--     type text                                                        (42804)
--
-- The `update job_opt_ins set status = case … end` above it is the same bug
-- against `public.opt_in_status`, and would have failed one statement earlier.
--
-- Only the casts change. The logic is 0007's, unaltered — the lock, the client
-- check, the eligibility check and the one-active-assignment check all stand
-- exactly as they were.
-- ============================================================================

create or replace function public.claim_job_assignment(
  p_job_id     uuid,
  p_worker_id  uuid,
  p_opt_in_id  uuid default null,
  p_payment_id uuid default null,
  p_source     public.assignment_source default 'shortlist'
)
returns public.job_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.jobs;
  claim  public.job_assignments;
  caller uuid := (select auth.uid());
begin
  -- Serialise every concurrent claim on this job before reading its state.
  select * into target from public.jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % does not exist', p_job_id using errcode = 'no_data_found';
  end if;

  -- auth.uid() is null under the service-role key; EXECUTE is granted only to
  -- authenticated and service_role, so a null caller is trusted server code.
  if caller is not null and caller <> target.client_id and not public.is_admin() then
    raise exception 'only the client of this job may assign it'
      using errcode = 'insufficient_privilege';
  end if;

  if target.status <> 'open' then
    raise exception 'job % is % and cannot be assigned', p_job_id, target.status
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.job_assignments a
    where a.job_id = p_job_id and a.status = 'active'
  ) then
    raise exception 'job % already has an active assignment', p_job_id
      using errcode = 'unique_violation';
  end if;

  if not public.is_active_worker(p_worker_id) then
    raise exception 'worker % is not eligible to take work', p_worker_id
      using errcode = 'check_violation';
  end if;

  insert into public.job_assignments (job_id, worker_id, opt_in_id, payment_id, source)
  values (p_job_id, p_worker_id, p_opt_in_id, p_payment_id, p_source)
  returning * into claim;

  update public.jobs
     set status             = 'assigned',
         assigned_worker_id = p_worker_id,
         assigned_at        = now()
   where id = p_job_id;

  update public.job_opt_ins o
     set status = case
                    when o.worker_id = p_worker_id then 'selected'::public.opt_in_status
                    else 'not_selected'::public.opt_in_status
                  end
   where o.job_id = p_job_id
     and o.status in ('active', 'shortlisted');

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id,
    caller,
    case
      when caller = target.client_id then 'client'::public.party_role
      when caller is null then 'system'::public.party_role
      else 'admin'::public.party_role
    end,
    'job.assigned',
    jsonb_build_object('worker_id', p_worker_id, 'source', p_source)
  );

  return claim;
end;
$$;

-- ============================================================================
-- open_job_payment — freeze the price, open the charge
--
-- Runs before Razorpay is told anything, so it is also the last cheap place to
-- refuse: a job that is not open, an opt-in that has been withdrawn, a second
-- attempt while one is already in flight.
--
-- `p_price` is the output of `lib/money/commission.ts`, which is the one
-- implementation of spec §8's arithmetic and stays the one implementation —
-- nothing here recomputes a slab percentage. What this checks are the identities
-- that must hold whatever the rates say: the shares sum to the gross, the
-- client's total is the budget plus their share, the worker's net is the budget
-- less theirs, and the budget is the one on the job. A transposed field or a
-- browser-supplied number fails those; a rate change does not.
--
-- The price is frozen in `job_financials`, which is append-only and keyed by
-- job. If a client abandons checkout and comes back a month later into a new
-- slab, the frozen row wins and the order is raised for what they were quoted.
-- ============================================================================

create or replace function public.open_job_payment(
  p_job_id        uuid,
  p_opt_in_id     uuid,
  p_actor_id      uuid,
  p_slab_id       uuid,
  p_tax_rate_id   uuid,
  p_price         jsonb,
  p_reuse_minutes integer default 15
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  target   public.jobs;
  opt_in   public.job_opt_ins;
  frozen   public.job_financials;
  existing public.payments;
  result   public.payments;

  v_budget       bigint := (p_price ->> 'budget_paise')::bigint;
  v_client_comm  bigint := (p_price ->> 'client_commission_paise')::bigint;
  v_client_tax   bigint := (p_price ->> 'client_tax_paise')::bigint;
  v_worker_comm  bigint := (p_price ->> 'worker_commission_paise')::bigint;
  v_worker_tax   bigint := (p_price ->> 'worker_tax_paise')::bigint;
  v_client_total bigint := (p_price ->> 'client_total_paise')::bigint;
  v_worker_net   bigint := (p_price ->> 'worker_net_paise')::bigint;
  v_gross        bigint := (p_price ->> 'platform_gross_paise')::bigint;
begin
  select * into target from public.jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % does not exist', p_job_id using errcode = 'no_data_found';
  end if;

  if target.client_id <> p_actor_id then
    raise exception 'only the client of this job may pay for it'
      using errcode = 'insufficient_privilege';
  end if;

  if target.status <> 'open' then
    raise exception 'job % is % and cannot be paid for', p_job_id, target.status
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.job_assignments a
    where a.job_id = p_job_id and a.status = 'active'
  ) then
    raise exception 'job % already has an active assignment', p_job_id
      using errcode = 'unique_violation';
  end if;

  select * into opt_in
  from public.job_opt_ins
  where id = p_opt_in_id and job_id = p_job_id;

  if not found then
    raise exception 'opt-in % is not on job %', p_opt_in_id, p_job_id
      using errcode = 'no_data_found';
  end if;

  if opt_in.status not in ('active', 'shortlisted') then
    raise exception 'opt-in % is % and cannot be selected', p_opt_in_id, opt_in.status
      using errcode = 'check_violation';
  end if;

  if not public.is_active_worker(opt_in.worker_id) then
    raise exception 'worker % is not eligible to take work', opt_in.worker_id
      using errcode = 'check_violation';
  end if;

  -- ---- the price must add up, and must be this job's ----------------------

  if target.budget_paise is null or v_budget <> target.budget_paise then
    raise exception 'priced % paise against a job whose budget is %',
      v_budget, target.budget_paise using errcode = 'check_violation';
  end if;

  if v_gross <> v_client_comm + v_worker_comm then
    raise exception 'commission shares (% + %) do not sum to the gross %',
      v_client_comm, v_worker_comm, v_gross using errcode = 'check_violation';
  end if;

  if v_client_total <> v_budget + v_client_comm + v_client_tax then
    raise exception 'client total % is not % + % + %',
      v_client_total, v_budget, v_client_comm, v_client_tax using errcode = 'check_violation';
  end if;

  if v_worker_net <> v_budget - v_worker_comm - v_worker_tax then
    raise exception 'worker net % is not % - % - %',
      v_worker_net, v_budget, v_worker_comm, v_worker_tax using errcode = 'check_violation';
  end if;

  -- Spec §8's slabs top out at 13%; a fee at half the job is a bug upstream,
  -- and this is the last point before a real card is charged.
  if v_gross <= 0 or v_gross * 2 >= v_budget then
    raise exception 'refusing a commission of % paise on a % paise job', v_gross, v_budget
      using errcode = 'check_violation';
  end if;

  -- ---- freeze it ----------------------------------------------------------

  insert into public.job_financials (
    job_id, slab_id, tax_rate_id, budget_paise,
    client_commission_bps, worker_commission_bps,
    client_commission_paise, worker_commission_paise,
    tax_rate_bps, client_tax_paise, worker_tax_paise,
    floor_applied, cap_applied,
    client_total_paise, worker_net_paise, platform_gross_paise
  )
  values (
    p_job_id, p_slab_id, p_tax_rate_id, v_budget,
    (p_price ->> 'client_commission_bps')::integer,
    (p_price ->> 'worker_commission_bps')::integer,
    v_client_comm, v_worker_comm,
    (p_price ->> 'tax_rate_bps')::integer, v_client_tax, v_worker_tax,
    coalesce((p_price ->> 'floor_applied')::boolean, false),
    coalesce((p_price ->> 'cap_applied')::boolean, false),
    v_client_total, v_worker_net, v_gross
  )
  on conflict (job_id) do nothing;

  -- Read back rather than use the values above: on a second attempt the row
  -- already there is the price this job was quoted, and it wins.
  select * into frozen from public.job_financials where job_id = p_job_id;

  -- ---- one live attempt at a time ----------------------------------------

  if exists (
    select 1 from public.payments
    where job_id = p_job_id and status in ('authorized', 'captured')
  ) then
    raise exception 'job % already has a payment in flight', p_job_id
      using errcode = 'unique_violation';
  end if;

  -- A client who reloaded the checkout gets the order they already have.
  -- Razorpay bills nothing for an unpaid order, but two live ones for a job is
  -- how a client ends up charged twice for the same hire.
  select * into existing
  from public.payments
  where job_id = p_job_id
    and status = 'created'
    and opt_in_id = p_opt_in_id
    and amount_paise = frozen.client_total_paise
    and razorpay_order_id is not null
    and created_at > now() - make_interval(mins => p_reuse_minutes)
  order by created_at desc
  limit 1;

  if found then
    return existing;
  end if;

  -- Anything else stale for this job is abandoned, and the partial unique index
  -- above will not have two of them.
  update public.payments
     set status = 'failed'::public.payment_status,
         failed_at = now(),
         failure_reason = 'superseded by a new checkout'
   where job_id = p_job_id and status = 'created';

  insert into public.payments (
    job_id, client_id, opt_in_id, status, amount_paise,
    job_budget_paise, client_commission_paise, client_tax_paise
  )
  values (
    p_job_id, p_actor_id, p_opt_in_id, 'created'::public.payment_status,
    frozen.client_total_paise, frozen.budget_paise,
    frozen.client_commission_paise, frozen.client_tax_paise
  )
  returning * into result;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id, p_actor_id, 'client'::public.party_role, 'payment.opened',
    jsonb_build_object(
      'payment_id', result.id,
      'opt_in_id', p_opt_in_id,
      'amount_paise', result.amount_paise
    )
  );

  return result;
end;
$$;

-- ============================================================================
-- settle_job_payment_and_assign — one transaction, or none of it
--
-- Called once Razorpay has actually captured the money. Everything it needs is
-- already on rows only server-side code can write: the frozen price in
-- `job_financials`, the amount and the gateway's real cut on `payments`, the
-- worker on the opt-in. It takes no amounts, so there is no number to get
-- wrong here and none to lie about.
--
-- Idempotent by construction, because it will be retried: the browser can call
-- it and then the `payment.captured` webhook can call it again, in either
-- order, and one of them will already have done the work. The ledger's
-- `idempotency_key` is what makes a replay harmless — that is what the column
-- is for.
-- ============================================================================

create or replace function public.settle_job_payment_and_assign(
  p_payment_id uuid,
  p_actor_id   uuid default null
)
returns public.job_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.jobs;
  pay    public.payments;
  frozen public.job_financials;
  opt_in public.job_opt_ins;
  claim  public.job_assignments;

  v_job_id  uuid;
  v_actor   uuid;
  v_txn_id  uuid;
  v_gateway bigint;

  acct_escrow   uuid;
  acct_revenue  uuid;
  acct_tax      uuid;
  acct_gateway  uuid;
  acct_external uuid;
begin
  select job_id into v_job_id from public.payments where id = p_payment_id;

  if v_job_id is null then
    raise exception 'payment % does not exist', p_payment_id using errcode = 'no_data_found';
  end if;

  -- Jobs before payments, always. `open_job_payment` takes them in that order
  -- too, and two functions that disagree about lock order deadlock the first
  -- time a client reloads checkout while a webhook lands.
  select * into target from public.jobs where id = v_job_id for update;
  select * into pay from public.payments where id = p_payment_id for update;

  v_actor := coalesce(p_actor_id, pay.client_id);

  if target.client_id <> pay.client_id or target.client_id <> v_actor then
    raise exception 'payment % does not belong to the client of job %', p_payment_id, v_job_id
      using errcode = 'insufficient_privilege';
  end if;

  -- ---- already done? ------------------------------------------------------

  if pay.status = 'captured' then
    select * into claim
    from public.job_assignments
    where job_id = v_job_id and status = 'active';

    if found then
      return claim;
    end if;
  end if;

  -- `razorpay_payment_id` is the token that says the gateway has the money.
  -- Only code that has captured writes it, and nothing here proceeds without it.
  if pay.razorpay_payment_id is null then
    raise exception 'payment % has no captured gateway payment behind it', p_payment_id
      using errcode = 'check_violation';
  end if;

  if pay.status not in ('authorized', 'captured') then
    raise exception 'payment % is %, not settleable', p_payment_id, pay.status
      using errcode = 'check_violation';
  end if;

  if pay.opt_in_id is null then
    raise exception 'payment % names no opt-in to assign', p_payment_id
      using errcode = 'check_violation';
  end if;

  select * into frozen from public.job_financials where job_id = v_job_id;

  if not found then
    raise exception 'job % has no frozen price', v_job_id using errcode = 'no_data_found';
  end if;

  if pay.amount_paise <> frozen.client_total_paise then
    raise exception 'payment % charged % but the job was priced at %',
      p_payment_id, pay.amount_paise, frozen.client_total_paise
      using errcode = 'check_violation';
  end if;

  select * into opt_in from public.job_opt_ins where id = pay.opt_in_id;

  if not found or opt_in.job_id <> v_job_id then
    raise exception 'opt-in % is not on job %', pay.opt_in_id, v_job_id
      using errcode = 'no_data_found';
  end if;

  -- ---- the money is ours to record ---------------------------------------

  update public.payments
     set status      = 'captured'::public.payment_status,
         captured_at = coalesce(captured_at, now())
   where id = p_payment_id;

  -- Escrow holds the budget. The worker's own commission is still inside it and
  -- comes out at release, which is when it is earned.
  if not exists (
    select 1 from public.escrow_holds
    where job_id = v_job_id and status in ('held', 'frozen')
  ) then
    insert into public.escrow_holds (job_id, payment_id, amount_paise, status)
    values (v_job_id, p_payment_id, frozen.budget_paise, 'held'::public.escrow_status);
  end if;

  -- ---- the ledger ---------------------------------------------------------

  insert into public.ledger_transactions (
    kind, job_id, reference_type, reference_id, description, idempotency_key, created_by
  )
  values (
    'payment_captured'::public.ledger_txn_kind, v_job_id, 'payment', p_payment_id,
    'Client payment captured at selection',
    'payment_captured:' || pay.razorpay_payment_id,
    v_actor
  )
  on conflict (idempotency_key) do nothing
  returning id into v_txn_id;

  -- Null means a replay got here first and the entries are already written.
  if v_txn_id is not null then
    select id into acct_escrow   from public.ledger_accounts where code = 'escrow';
    select id into acct_revenue  from public.ledger_accounts where code = 'platform_revenue';
    select id into acct_tax      from public.ledger_accounts where code = 'tax_payable';
    select id into acct_gateway  from public.ledger_accounts where code = 'gateway_fees';
    select id into acct_external from public.ledger_accounts where code = 'external';

    if acct_escrow is null or acct_revenue is null or acct_tax is null
       or acct_gateway is null or acct_external is null then
      raise exception 'the platform ledger accounts are missing. Check migration 0018.'
        using errcode = 'no_data_found';
    end if;

    -- In, from the world outside Zevi.
    insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
    values (v_txn_id, acct_external, 'credit'::public.ledger_direction, pay.amount_paise, v_job_id);

    -- Out, three ways.
    insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
    values (v_txn_id, acct_escrow, 'debit'::public.ledger_direction, frozen.budget_paise, v_job_id);

    if frozen.client_commission_paise > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_revenue, 'debit'::public.ledger_direction,
              frozen.client_commission_paise, v_job_id);
    end if;

    if frozen.client_tax_paise > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_tax, 'debit'::public.ledger_direction,
              frozen.client_tax_paise, v_job_id);
    end if;

    -- Razorpay's cut, as a cost against revenue. Balances on its own two legs,
    -- so the deferred balance trigger is satisfied either way.
    v_gateway := coalesce(pay.gateway_fee_paise, 0) + coalesce(pay.gateway_tax_paise, 0);

    if v_gateway > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_gateway, 'debit'::public.ledger_direction, v_gateway, v_job_id);

      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_revenue, 'credit'::public.ledger_direction, v_gateway, v_job_id);
    end if;

    -- ---- who did it, and what it cost ------------------------------------
    --
    -- Written before the claim so the timeline reads paid, then assigned, and
    -- inside the same guard as the ledger so a retry does not write it twice —
    -- `job_events` is append-only, so a duplicate is permanent.
    --
    -- The actor is the client. `claim_job_assignment` runs under the
    -- service-role key from here and records its own event as 'system', which
    -- is accurate — the settlement assigned the job — and this is the row that
    -- names the person who paid for it.

    insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
    values (
      v_job_id, v_actor, 'client'::public.party_role, 'job.paid',
      jsonb_build_object(
        'payment_id', p_payment_id,
        'razorpay_payment_id', pay.razorpay_payment_id,
        'amount_paise', pay.amount_paise,
        'budget_paise', frozen.budget_paise,
        'commission_paise', frozen.platform_gross_paise,
        'client_commission_paise', frozen.client_commission_paise,
        'client_tax_paise', frozen.client_tax_paise,
        'escrow_paise', frozen.budget_paise,
        'gateway_fee_paise', v_gateway
      )
    );
  end if;

  -- The lock on `jobs` is already ours, so this cannot race a second click.
  claim := public.claim_job_assignment(
    p_job_id     => v_job_id,
    p_worker_id  => opt_in.worker_id,
    p_opt_in_id  => pay.opt_in_id,
    p_payment_id => p_payment_id,
    p_source     => 'shortlist'::public.assignment_source
  );

  return claim;
end;
$$;

-- ============================================================================
-- fail_job_payment — the other ending
--
-- A declined card is not an error on our side and leaves nothing to unwind: no
-- escrow, no ledger entries, no assignment. The job stays open and the opt-ins
-- stay live, so the client can pick again.
-- ============================================================================

create or replace function public.fail_job_payment(
  p_payment_id uuid,
  p_reason     text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  pay      public.payments;
  v_job_id uuid;
begin
  select job_id into v_job_id from public.payments where id = p_payment_id;

  if v_job_id is null then
    raise exception 'payment % does not exist', p_payment_id using errcode = 'no_data_found';
  end if;

  -- Jobs before payments, the same order the other two take them in. This
  -- function ends by inserting a `job_events` row, whose foreign key takes a
  -- lock on the job anyway — acquiring it first is what stops a failure webhook
  -- and a settlement deadlocking over the same pair.
  perform 1 from public.jobs where id = v_job_id for update;

  select * into pay from public.payments where id = p_payment_id for update;

  -- Captured money is not failed money, whatever a late webhook says.
  if pay.status = 'captured' then
    return pay;
  end if;

  update public.payments
     set status         = 'failed'::public.payment_status,
         failed_at      = coalesce(failed_at, now()),
         failure_reason = coalesce(p_reason, failure_reason)
   where id = p_payment_id
  returning * into pay;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    pay.job_id, pay.client_id, 'client'::public.party_role, 'payment.failed',
    jsonb_build_object('payment_id', pay.id, 'reason', p_reason)
  );

  return pay;
end;
$$;

-- ============================================================================
-- Grants
--
-- All three move money or decide that money moved. None is callable from a
-- browser: `authenticated` gets nothing, and the Server Actions that call them
-- hold the service-role key and re-derive the caller from the session first.
-- ============================================================================

revoke execute on function public.open_job_payment(uuid, uuid, uuid, uuid, uuid, jsonb, integer)
  from public, anon, authenticated;
grant execute on function public.open_job_payment(uuid, uuid, uuid, uuid, uuid, jsonb, integer)
  to service_role;

revoke execute on function public.settle_job_payment_and_assign(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.settle_job_payment_and_assign(uuid, uuid)
  to service_role;

revoke execute on function public.fail_job_payment(uuid, text)
  from public, anon, authenticated;
grant execute on function public.fail_job_payment(uuid, text) to service_role;
