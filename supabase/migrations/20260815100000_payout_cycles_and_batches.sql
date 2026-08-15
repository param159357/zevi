-- ============================================================================
-- Zevi 0031 — the twice-weekly payout cycle
--
-- Spec §6 "Payouts", and the third moment of the money 0029 and 0030 built:
--
--   0029  capture      the client's card → escrow, client's commission earned
--   0030  acceptance   escrow → worker payable, worker's commission earned,
--                      and a `worker_earnings` row stamped with when it matures
--   0031  the cycle    those earnings gathered into a batch, twice a week
--
--   Cycle closes Wednesday midnight → paid Friday
--   Cycle closes Sunday    midnight → paid Tuesday
--
-- Resolved into instants — and this is the one ambiguous sentence in the spec,
-- so it is worth being exact: **"Wednesday midnight" is the midnight that ends
-- Wednesday.** The cutoff is therefore Thursday 00:00 IST, and work accepted
-- during Wednesday is in Friday's run. The other reading would mean nothing
-- happening on Wednesday counted toward the cycle closing on Wednesday.
--
--   cutoff Thursday 00:00 IST → pays Friday
--   cutoff Monday   00:00 IST → pays Tuesday
--
-- ---------------------------------------------------------------------------
-- Where the calendar lives, and why not here
--
-- `lib/payouts/cycle.ts` computes which cutoff is which, because it is a pure
-- function of the clock with no rows to lock, and two screens need it before any
-- batch exists ("your next payout is Friday"). One implementation, reachable by
-- the test runner, beats one in a Server Component and one in plpgsql drifting
-- apart.
--
-- What stays here is the invariant. `build_payout_batch()` refuses a cutoff that
-- is not midnight IST on a Thursday or a Monday, and refuses one in the future.
-- A caller that computed the wrong instant — or a compromised cron asking to pay
-- everyone today — cannot make an early payout representable. That is a shape
-- check on the calendar's output, not a second copy of it.
--
-- ---------------------------------------------------------------------------
-- Three reasons money sits still, and only one of them is a judgement
--
-- 0013 gave `worker_earnings` three separate columns so a worker's dashboard can
-- name which applies, and 0030 stamps two of them at acceptance:
--
--   eligible_at      acceptance + 48 hours (spec §6's eligibility rule)
--   hold_until       the new client's 14-day chargeback window, first 3 jobs
--   status='frozen'  a dispute or a chargeback investigation
--
-- Neither of the first two is recomputed here. A worker told "Friday" is paid
-- Friday even if the settings move on Thursday.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do
--
--   * Move money. A `payouts` row is created `pending` and nothing disburses it,
--     because Razorpay's payout API is not wired and no worker has a verified
--     destination to send to (see the KYC note on `build_payout_batch`). So no
--     ledger entries are written here either, and that is the honest position
--     rather than a gap: nothing has left `worker_payable`, so the ledger saying
--     the platform still owes it is exactly right. `payout_paid` and
--     `payout_failed` — both already in `ledger_txn_kind` — are what the
--     disbursement step will write when there is one.
--   * Penalties. `worker_adjustments` exists and `payout_items.amount_paise` is
--     signed for it, but nothing on the platform writes an adjustment yet, so
--     the draw-down is a loop over an always-empty table. It goes in with the
--     penalty system, not before it.
--   * Instant payout (spec §16 defers it) and the ₹15 fee that goes with it.
-- ============================================================================

insert into public.platform_settings (key, value, value_type, description, is_public)
values (
  'payout.pay_run_hour_ist', '11', 'int',
  'Hour of the pay day, IST, that a batch is scheduled to disburse at (spec §6).', true
)
on conflict (key) do nothing;

-- ============================================================================
-- release_matured_earning_holds — the 14-day window expiring
--
-- Spec §6's new-client hold is a wait, not a decision: nobody reviews it and
-- nothing has to approve it. 0030 stamps `hold_until` and starts the earning at
-- `on_hold`; this is what ends it.
--
-- Separate from the batch builder, and called by the same cron, so the row says
-- something true on the day the hold expires rather than on the next pay day. A
-- worker watching a held balance should not see "Held" for three days after the
-- fourteen are up.
--
-- `frozen` is untouched on purpose. That is the one of the three that *is* a
-- judgement, and it comes back by a person's hand.
-- ============================================================================

create or replace function public.release_matured_earning_holds()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released integer;
begin
  -- `hold_until` and `hold_reason` are left exactly as they were. They are the
  -- record of why this money waited a fortnight, and a worker asking that
  -- question in March about a January job deserves the answer.
  update public.worker_earnings e
     set status = 'confirmed'::public.earning_status
   where e.status = 'on_hold'::public.earning_status
     and e.hold_until is not null
     and e.hold_until <= now();

  get diagnostics v_released = row_count;

  return v_released;
end;
$$;

comment on function public.release_matured_earning_holds is
  'Ends the new-client chargeback hold once `hold_until` has passed: on_hold → '
  'confirmed. Leaves `frozen` alone — that one needs a person (0031).';

-- ============================================================================
-- build_payout_batch — the cycle, assembled
--
-- One transaction. A batch whose payouts do not sum to its total, or whose
-- earnings are marked `in_payout` against a payout that was never written, is a
-- worker who cannot be told what they are owed. Neither is representable.
--
-- Safe to call twice, and it will be: the cron runs daily and only two of those
-- days have a cutoff worth building. A batch already built comes back as it is.
--
-- ---------------------------------------------------------------------------
-- The KYC gate, which is why batches are empty today
--
-- `payouts.payout_method_id` is NOT NULL, and a `payout_methods` row only exists
-- once a worker has been through KYC — which spec §6 puts "before first payout,
-- not at signup", and which is not built. So every worker is skipped for want of
-- a verified destination, and this function will assemble empty batches until
-- KYC lands.
--
-- That is the correct behaviour and not a stub. A skipped worker's earnings are
-- left `confirmed` and untouched, so they roll into the next cycle exactly as
-- spec §6's "anything short rolls forward" describes, and they are counted and
-- returned so the cron can say how much money is waiting on KYC. The day
-- `payout_methods` has verified rows in it, this pays them with no change here.
-- ============================================================================

create or replace function public.build_payout_batch(
  p_cutoff_at   timestamptz,
  p_max_workers integer default 500
)
returns table (
  batch_id         uuid,
  cutoff_at        timestamptz,
  scheduled_pay_at timestamptz,
  status           public.payout_batch_status,
  payouts_created  integer,
  earnings_claimed integer,
  total_paise      bigint,
  workers_skipped  integer,
  skipped_paise    bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch        public.payout_batches;
  method       public.payout_methods;
  disbursement public.payouts;
  candidate    record;
  claimed      record;

  v_wall         timestamp;
  v_isodow       integer;
  v_pay_hour     integer;
  v_cycle_start  timestamptz;
  v_pay_at       timestamptz;
  v_cap          integer := greatest(coalesce(p_max_workers, 500), 0);

  v_payouts      integer := 0;
  v_earnings     integer := 0;
  v_total        bigint  := 0;
  v_skipped      integer := 0;
  v_skipped_sum  bigint  := 0;

  v_worker_total bigint;
  v_capped       boolean := false;
begin
  if p_cutoff_at is null then
    raise exception 'a payout batch needs a cutoff' using errcode = 'null_value_not_allowed';
  end if;

  -- ---- is this a real cycle boundary? -------------------------------------
  --
  -- The shape check described at the top of this file. Everything below trusts
  -- the cutoff completely — it is the only thing deciding who gets paid — so it
  -- is established here and nowhere else.

  v_wall   := p_cutoff_at at time zone 'Asia/Kolkata';
  v_isodow := extract(isodow from v_wall);

  if v_wall <> date_trunc('day', v_wall) then
    raise exception 'payout cutoff % is not midnight IST', p_cutoff_at
      using errcode = 'check_violation';
  end if;

  -- Monday = 1, Thursday = 4: the midnights that end Sunday and Wednesday.
  if v_isodow not in (1, 4) then
    raise exception
      'payout cutoff % is a %; cycles close at midnight IST on Wednesday and Sunday',
      p_cutoff_at, to_char(v_wall, 'FMDay') using errcode = 'check_violation';
  end if;

  -- The one that makes an early payout impossible from here.
  if p_cutoff_at > now() then
    raise exception 'payout cutoff % has not arrived yet', p_cutoff_at
      using errcode = 'check_violation';
  end if;

  -- Thursday's cycle opened on Monday (3 days), Monday's opened on Thursday (4).
  -- Twice a week on fixed weekdays cannot be evenly spaced; nothing depends on
  -- its being so, and `cycle_start_at` is a record of the window, not a filter.
  v_cycle_start := (v_wall - make_interval(days => case when v_isodow = 1 then 4 else 3 end))
                     at time zone 'Asia/Kolkata';

  v_pay_hour := public.setting_int('payout.pay_run_hour_ist', 11);
  v_pay_at   := (v_wall + interval '1 day' + make_interval(hours => v_pay_hour))
                  at time zone 'Asia/Kolkata';

  -- ---- the batch row ------------------------------------------------------
  --
  -- `cutoff_at` is unique, so this is what serialises two builders racing on the
  -- same cycle: the loser blocks on the row lock below, then finds it closed.

  insert into public.payout_batches (cycle_start_at, cutoff_at, scheduled_pay_at, status)
  values (v_cycle_start, p_cutoff_at, v_pay_at, 'open'::public.payout_batch_status)
  on conflict (cutoff_at) do nothing;

  select * into batch
  from public.payout_batches b
  where b.cutoff_at = p_cutoff_at
  for update;

  -- Already assembled — by an earlier run, or by the builder we just queued
  -- behind. Reported, not rebuilt.
  if batch.status <> 'open'::public.payout_batch_status then
    return query
      select batch.id, batch.cutoff_at, batch.scheduled_pay_at, batch.status,
             (select count(*)::integer from public.payouts p where p.batch_id = batch.id),
             (select count(*)::integer from public.worker_earnings e where e.payout_id in
                (select p.id from public.payouts p where p.batch_id = batch.id)),
             batch.total_paise, 0, 0::bigint;
    return;
  end if;

  -- ---- the holds that have run out ----------------------------------------
  --
  -- Before selecting, so an earning whose 14 days expired an hour ago is in this
  -- batch rather than the next. The `hold_until <= cutoff` test below is still
  -- what decides it: a hold that expired *after* this cutoff but before now is
  -- released to `confirmed` here and correctly left for the next cycle.

  perform public.release_matured_earning_holds();

  -- ---- one payout per worker ----------------------------------------------
  --
  -- Note what is NOT in this predicate: any lower bound on `eligible_at`. The
  -- batch takes everything mature, not everything mature *since* the last run,
  -- which is what makes spec §6's "anything short rolls forward" need no
  -- special case — and what makes a cron that failed for a week pay late rather
  -- than pay short.

  for candidate in
    select e.worker_id as worker_id, sum(e.net_paise) as payable_paise
    from public.worker_earnings e
    where e.status = 'confirmed'::public.earning_status
      and e.payout_id is null
      and e.eligible_at is not null
      and e.eligible_at <= p_cutoff_at
      and (e.hold_until is null or e.hold_until <= p_cutoff_at)
      and e.net_paise > 0
    group by e.worker_id
    order by e.worker_id
  loop
    if v_payouts >= v_cap then
      -- The batch stays `open` and the next run carries on filling it. A capped
      -- run is a slower payout, never a lost one.
      v_capped := true;
      exit;
    end if;

    -- Spec §6: KYC before the first payout. No verified destination, no payout —
    -- and the earnings stay `confirmed` for the next cycle rather than being
    -- claimed by a batch that cannot pay them.
    select * into method
    from public.payout_methods pm
    where pm.worker_id = candidate.worker_id
      and pm.status = 'verified'::public.payout_method_status
      and pm.disabled_at is null
    order by pm.is_default desc, pm.verified_at nulls last
    limit 1;

    if not found then
      v_skipped     := v_skipped + 1;
      v_skipped_sum := v_skipped_sum + candidate.payable_paise;
      continue;
    end if;

    insert into public.payouts (batch_id, worker_id, payout_method_id, amount_paise, status)
    values (
      batch.id, candidate.worker_id, method.id, candidate.payable_paise,
      'pending'::public.payout_status
    )
    returning * into disbursement;

    -- The claim and the lines come from the same UPDATE, so the payout's amount
    -- is the sum of what it actually took rather than of what was there a
    -- statement ago. `FOR UPDATE` semantics re-check the predicate after the
    -- lock, so a row another builder claimed in between is simply not returned.
    v_worker_total := 0;

    for claimed in
      update public.worker_earnings e
         set status    = 'in_payout'::public.earning_status,
             payout_id = disbursement.id
       where e.worker_id = candidate.worker_id
         and e.status = 'confirmed'::public.earning_status
         and e.payout_id is null
         and e.eligible_at is not null
         and e.eligible_at <= p_cutoff_at
         and (e.hold_until is null or e.hold_until <= p_cutoff_at)
         and e.net_paise > 0
      returning e.id, e.job_id, e.net_paise
    loop
      insert into public.payout_items (payout_id, kind, earning_id, job_id, amount_paise, label)
      select
        disbursement.id, 'earning'::public.payout_item_kind, claimed.id, claimed.job_id,
        claimed.net_paise, coalesce(nullif(btrim(j.title), ''), 'Completed job')
      from public.jobs j
      where j.id = claimed.job_id;

      v_worker_total := v_worker_total + claimed.net_paise;
      v_earnings     := v_earnings + 1;
    end loop;

    if v_worker_total = 0 then
      -- Everything was claimed by a concurrent builder between the aggregate and
      -- the update. `amount_paise > 0` forbids a zero payout, and an empty one
      -- would be a line on a worker's statement for nothing.
      delete from public.payouts where id = disbursement.id;
      continue;
    end if;

    if v_worker_total <> disbursement.amount_paise then
      update public.payouts set amount_paise = v_worker_total where id = disbursement.id;
    end if;

    v_payouts := v_payouts + 1;
    v_total   := v_total + v_worker_total;
  end loop;

  -- ---- close it -----------------------------------------------------------
  --
  -- `closed` is the resting state: assembled, and waiting on the batch review
  -- spec §7 asks for before each run. `under_review` and `processing` belong to
  -- the disbursement step, which does not exist yet.

  -- Aliased, and the right-hand sides qualified with it, because this function's
  -- OUT parameters include `total_paise` and `status`: an unqualified column
  -- reference here resolves to the variable and Postgres refuses the ambiguity
  -- at runtime rather than at deploy.
  update public.payout_batches b
     set status      = case when v_capped then 'open'::public.payout_batch_status
                            else 'closed'::public.payout_batch_status end,
         total_paise = b.total_paise + v_total,
         item_count  = b.item_count + v_earnings
   where b.id = batch.id
  returning * into batch;

  return query
    select batch.id, batch.cutoff_at, batch.scheduled_pay_at, batch.status,
           v_payouts, v_earnings, batch.total_paise, v_skipped, v_skipped_sum;
end;
$$;

comment on function public.build_payout_batch is
  'Assembles the batch for a cycle cutoff (Thursday or Monday 00:00 IST): '
  'releases matured holds, claims every mature unheld earning, and writes one '
  'payout per worker with a verified destination. Refuses a cutoff that is not '
  'a real boundary or has not arrived (0031).';

-- ============================================================================
-- cancel_payout_batch — the way back
--
-- A batch that cannot be un-built is a trap: its earnings sit at `in_payout`,
-- invisible to every later cycle, with no path to a worker's account. That is
-- worse than never having built it, so the reversal ships with the builder
-- rather than with the disbursement step that will need it for spec §14's
-- failed-payout queue.
--
-- It is cheap precisely because the builder writes no ledger entries: nothing
-- moved, so nothing has to be moved back. Once disbursement exists this may only
-- cancel what is still `pending` — the guard below already says so.
-- ============================================================================

create or replace function public.cancel_payout_batch(
  p_batch_id uuid,
  p_actor_id uuid,
  p_reason   text
)
returns public.payout_batches
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch    public.payout_batches;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if char_length(v_reason) < 3 then
    raise exception 'cancelling a payout batch needs a reason'
      using errcode = 'check_violation';
  end if;

  select * into batch from public.payout_batches where id = p_batch_id for update;

  if not found then
    raise exception 'payout batch % does not exist', p_batch_id using errcode = 'no_data_found';
  end if;

  if batch.status in ('processing'::public.payout_batch_status,
                      'completed'::public.payout_batch_status) then
    raise exception 'payout batch % is % and money may already have moved',
      p_batch_id, batch.status using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.payouts p
    where p.batch_id = p_batch_id and p.status <> 'pending'::public.payout_status
  ) then
    raise exception 'payout batch % has payouts past pending', p_batch_id
      using errcode = 'check_violation';
  end if;

  -- Back to `confirmed`, which is where the next cycle will find them. The
  -- earning's own `eligible_at` and `hold_until` were never touched, so it
  -- returns to the queue at the same place in it.
  update public.worker_earnings e
     set status    = 'confirmed'::public.earning_status,
         payout_id = null
   where e.payout_id in (select p.id from public.payouts p where p.batch_id = p_batch_id);

  delete from public.payout_items
   where payout_id in (select p.id from public.payouts p where p.batch_id = p_batch_id);

  update public.payouts
     set status = 'cancelled'::public.payout_status
   where batch_id = p_batch_id;

  update public.payout_batches
     set status       = 'failed'::public.payout_batch_status,
         failure_note = v_reason,
         total_paise  = 0,
         item_count   = 0
   where id = p_batch_id
  returning * into batch;

  if p_actor_id is not null then
    insert into public.admin_audit_log (admin_id, action, target_table, target_id, reason)
    values (p_actor_id, 'payout_batch.cancelled', 'payout_batches', p_batch_id, v_reason);
  end if;

  return batch;
end;
$$;

comment on function public.cancel_payout_batch is
  'Unbuilds a batch that has not been disbursed: earnings back to confirmed for '
  'the next cycle, payouts cancelled, lines removed (0031).';

-- ============================================================================
-- RLS
--
-- 0013 gave workers a read on their own `payouts` and `payout_items` but left
-- `payout_batches` to finance admins, which leaves the one fact a worker most
-- wants — *when* — behind a join they cannot make. The batch a worker is in is
-- not confidential; the batch they are not in is.
-- ============================================================================

create policy "workers read the batches they are paid in"
  on public.payout_batches for select to authenticated
  using (
    exists (
      select 1 from public.payouts p
      where p.batch_id = payout_batches.id and p.worker_id = (select auth.uid())
    )
  );

-- ============================================================================
-- Grants
--
-- All three decide, or unwind, who gets money. None is callable from a browser.
-- ============================================================================

revoke execute on function public.release_matured_earning_holds()
  from public, anon, authenticated;
grant execute on function public.release_matured_earning_holds() to service_role;

revoke execute on function public.build_payout_batch(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.build_payout_batch(timestamptz, integer) to service_role;

revoke execute on function public.cancel_payout_batch(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_payout_batch(uuid, uuid, text) to service_role;
