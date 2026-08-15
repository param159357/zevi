-- ============================================================================
-- Zevi 0032 — `build_payout_batch()`: the ON CONFLICT target was ambiguous
--
-- 0031 acquired its batch row with:
--
--     insert into public.payout_batches (cycle_start_at, cutoff_at, ...) values (...)
--     on conflict (cutoff_at) do nothing;
--
-- and that raises `42702 column reference "cutoff_at" is ambiguous` the first
-- time it runs, because the function's OUT parameters include one named
-- `cutoff_at`.
--
-- The reason it is worth a migration of its own rather than a quiet edit: this
-- is a *third* variant of the mistake 0025, 0026 and 0029 each fixed one of, and
-- the distinction is not obvious. In a plpgsql function body, some column
-- positions are substituted with variables of the same name and some are not:
--
--     insert into t (col) ...          NOT substituted — an INSERT column list
--     update t set col = ...           NOT substituted — a SET target
--     ... where col = x                substituted     — an ordinary expression
--     on conflict (col)                substituted     — an index inference spec
--
-- The first two are why the rest of 0031's writes are safe unqualified, and it
-- is easy to reason from them straight past the fourth. The ordinary expressions
-- in 0031 were all written qualified (`e.status`, `b.total_paise`) for exactly
-- this reason; the ON CONFLICT target is the one place a qualification is not
-- syntactically allowed, so it cannot be fixed the same way.
--
-- `on conflict on constraint <name>` would work — a constraint name is not a
-- column reference — but `payout_batches.cutoff_at` is declared inline `unique`,
-- so the only name available is the one Postgres generated. Depending on that in
-- a function is a worse trade than the four extra lines below.
--
-- So: look first, insert if it is not there, and handle the loser of the race
-- explicitly. Same outcome, no inference clause, and the concurrency is now
-- visible rather than delegated. `supabase db lint --linked` is what found this,
-- and it is worth running against any new plpgsql that writes money.
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
  -- Everything below trusts the cutoff completely — it is the only thing
  -- deciding who gets paid — so it is established here and nowhere else.

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
  v_cycle_start := (v_wall - make_interval(days => case when v_isodow = 1 then 4 else 3 end))
                     at time zone 'Asia/Kolkata';

  v_pay_hour := public.setting_int('payout.pay_run_hour_ist', 11);
  v_pay_at   := (v_wall + interval '1 day' + make_interval(hours => v_pay_hour))
                  at time zone 'Asia/Kolkata';

  -- ---- the batch row ------------------------------------------------------
  --
  -- Locked on the way in, because it is what serialises two builders racing on
  -- the same cycle: the loser blocks here and then finds the batch closed.

  select * into batch
  from public.payout_batches b
  where b.cutoff_at = p_cutoff_at
  for update;

  if not found then
    begin
      insert into public.payout_batches (cycle_start_at, cutoff_at, scheduled_pay_at, status)
      values (v_cycle_start, p_cutoff_at, v_pay_at, 'open'::public.payout_batch_status)
      returning * into batch;
    exception when unique_violation then
      -- A concurrent builder inserted it between the select and the insert.
      -- Theirs stands; take the row and its lock and carry on.
      select * into batch
      from public.payout_batches b
      where b.cutoff_at = p_cutoff_at
      for update;
    end;
  end if;

  -- Already assembled — by an earlier run, or by the builder we queued behind.
  -- Reported, not rebuilt.
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
  -- which is what makes spec §6's "anything short rolls forward" need no special
  -- case — and what makes a cron that failed for a week pay late, not short.

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
    -- statement ago.
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
  --
  -- Aliased, and the right-hand sides qualified with it, because this function's
  -- OUT parameters include `total_paise` and `status` — see the header.

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
  'a real boundary or has not arrived (0031, ON CONFLICT ambiguity fixed 0032).';
