-- ============================================================================
-- Zevi 0034 — the console's decisions
--
-- Spec §7 describes the admin side as a work queue with five modules. Two of
-- them were built with their own decision functions (0027 worker approvals,
-- 0033 KYC). This migration is the other three:
--
--   resolve_dispute()      release · refund · split, with a required note
--   apply_user_sanction()  warn · suspend · ban
--   lift_user_sanction()   the way back from the two that expire
--   review_payout_batch()  the batch review spec §7 puts before each run
--   retry_failed_payout()  spec §14's failed-payout queue
--
-- Every one of them follows the shape 0027 and 0033 established, and it is worth
-- restating because it is the whole security model of the console:
--
--   1. `requireAdmin(perm)` in the page decides what renders
--   2. the `admin_can(perm)` policies decide what the queries return
--   3. the function looks the permission up **again**, from the actor's id,
--      because under the service-role key `auth.uid()` is null and `admin_can()`
--      would cheerfully answer false for a super admin
--
-- And every one writes `admin_audit_log`, which is append-only by trigger. Spec
-- §7 makes that permanent and mandates a reason on each entry, so a reason under
-- three characters is refused rather than stored.
--
-- ---------------------------------------------------------------------------
-- What resolve_dispute() moves, and what it deliberately does not
--
-- A dispute is decided while the job's money is still in escrow. That bound is
-- load-bearing and enforced: if the hold has already been released the function
-- refuses, because reversing a paid earning is a different flow (`earning_status`
-- has 'reversed' for it) and pretending otherwise here would take money back off
-- a worker with no record of having done so. Spec §11 does allow a client to
-- raise a dispute up to 48 hours after acceptance; that case lands on
-- `escrow_settled` and a person, not on a half-built clawback.
--
-- Of the three outcomes, only the worker's side can complete today:
--
--   release   escrow → worker payable + platform revenue + tax payable. This is
--             byte-for-byte the ledger transaction `accept_job_delivery()`
--             writes, with the same figures off the same frozen `job_financials`
--             row — a full release IS an acceptance, arrived at the slow way.
--   refund    the client's money is still in the platform's Razorpay account and
--             Razorpay's refund API is not wired. So a `refunds` row is created
--             `pending`, the escrow hold records the decision, and **no ledger
--             entry is written** — because nothing has moved. That is exactly
--             the position 0031 leaves a payout in, for exactly the same reason.
--   split     both of the above, pro-rated. The worker's share leaves escrow
--             through the ledger; the client's share becomes a pending refund.
--
-- The ledger therefore stays true throughout: the escrow account's balance is
-- what the platform still holds, and `escrow_holds` is what has been decided
-- about it. The two disagreeing is not drift — it is the gap where the gateway
-- call goes.
--
-- ---------------------------------------------------------------------------
-- Two things spec §11 mentions that are not written here
--
--   * The ₹15 dispute fee, "charged to whoever loses". Charging it means either
--     a ledger movement against a party or a `worker_adjustments` row, and
--     nothing on the platform writes an adjustment yet (0031 says so about
--     penalties for the same reason). A `fee_paise` of 0 is true; a ₹15 nobody
--     collected would not be.
--   * The client's commission and GST, recognised as revenue at capture (0029).
--     Whether a client who wins a dispute gets those back is a policy decision
--     spec §8 and §14 do not make — §14 commits only to absorbing the gateway
--     fee — so this refunds what was in escrow, which is the budget, and leaves
--     the question where it belongs rather than answering it in a function.
-- ============================================================================

-- ============================================================================
-- resolve_dispute — release · refund · split
--
-- Returns one row. `status` is one of:
--   resolved · not_found · forbidden · invalid_outcome · note_required ·
--   split_share_required · already_decided · escrow_settled · not_priced
-- ============================================================================

create or replace function public.resolve_dispute(
  p_dispute_id       uuid,
  p_admin_id         uuid,
  p_outcome          text,
  p_decision_note    text,
  p_split_client_bps integer default null,
  p_ip               inet default null
)
returns table (
  status        text,
  outcome       public.dispute_outcome,
  worker_paise  bigint,
  client_paise  bigint,
  detail        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case   public.disputes%rowtype;
  v_job    public.jobs%rowtype;
  v_frozen public.job_financials%rowtype;
  v_hold   public.escrow_holds%rowtype;
  v_claim  public.job_assignments%rowtype;

  v_note        text := nullif(btrim(coalesce(p_decision_note, '')), '');
  v_outcome     public.dispute_outcome;
  v_before      jsonb;
  v_job_id      uuid;
  v_worker_id   uuid;
  v_payment_id  uuid;
  v_txn_id      uuid;
  v_worker_acct uuid;
  v_on_time     boolean;

  -- The worker's share, in basis points of the budget. 10000 on a release, 0 on
  -- a refund, and whatever is left over from the client's share on a split.
  v_worker_bps  integer;
  v_worker_sum  bigint;
  v_client_sum  bigint;
  v_worker_comm bigint;
  v_worker_tax  bigint;
  v_worker_net  bigint;

  v_acct_escrow  uuid;
  v_acct_revenue uuid;
  v_acct_tax     uuid;
begin
  -- ---- what was asked for -------------------------------------------------

  if p_outcome not in ('release', 'refund', 'split') then
    return query select 'invalid_outcome'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  v_outcome := p_outcome::public.dispute_outcome;

  -- Mirrors `disputes_decision_has_note`, so a reviewer reads a sentence rather
  -- than a constraint name. Spec §7: required internal note on every decision.
  if v_note is null or char_length(v_note) < 10 then
    return query select 'note_required'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  v_note := left(v_note, 2000);

  if v_outcome = 'split'::public.dispute_outcome
     and (p_split_client_bps is null or p_split_client_bps not between 0 and 10000) then
    return query select 'split_share_required'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  -- ---- who is asking ------------------------------------------------------
  --
  -- The third of the three checks. `auth.uid()` is null under the service-role
  -- key, so `admin_can()` cannot be used here and the membership is read from
  -- the actor's id directly.

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'resolve_disputes' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  -- ---- the rows, in the lock order the money functions all take ------------
  --
  -- Jobs first, then the dispute, then escrow. 0029's three functions and
  -- 0030's four take jobs first for the same reason: two orders deadlock the
  -- first time an admin decides a case while a webhook settles the payment.

  select d.job_id into v_job_id from public.disputes d where d.id = p_dispute_id;

  if v_job_id is null then
    return query select 'not_found'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  select * into v_job from public.jobs j where j.id = v_job_id for update;
  select * into v_case from public.disputes d where d.id = p_dispute_id for update;

  if v_case.status in ('resolved'::public.dispute_status, 'closed'::public.dispute_status)
     or v_case.outcome is not null then
    return query select 'already_decided'::text, v_case.outcome,
                        null::bigint, null::bigint, null::text;
    return;
  end if;

  select * into v_frozen from public.job_financials f where f.job_id = v_job_id;

  if not found then
    return query select 'not_priced'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint,
                        'This job has no frozen price, so nothing was ever paid for it.'::text;
    return;
  end if;

  select * into v_hold
  from public.escrow_holds h
  where h.job_id = v_job_id
    and h.status in ('held'::public.escrow_status, 'frozen'::public.escrow_status)
  for update;

  if not found then
    -- Either nothing was held, or acceptance already released it. The second is
    -- spec §11's post-acceptance window, and it needs an earning reversed rather
    -- than an escrow settled. Refused rather than approximated.
    return query select 'escrow_settled'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint,
                        ('Escrow on this job is no longer held, so there is nothing here to '
                         || 'divide. A dispute raised after acceptance needs the worker''s '
                         || 'earning reversed, which is not built.')::text;
    return;
  end if;

  if v_hold.amount_paise <> v_frozen.budget_paise then
    return query select 'not_priced'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint,
                        format('Escrow holds %s paise but the job was priced at %s.',
                               v_hold.amount_paise, v_frozen.budget_paise)::text;
    return;
  end if;

  -- The assignment is the authority on whose work this is; `jobs` carries the
  -- same id and is the fallback. Deliberately not `disputes.raised_by` — either
  -- party may raise one (spec §11), so that column names a complainant and never
  -- a payee.
  select * into v_claim
  from public.job_assignments a
  where a.job_id = v_job_id
    and a.status = 'active'::public.assignment_status;

  v_worker_id := coalesce(v_claim.worker_id, v_job.assigned_worker_id);

  -- ---- the arithmetic -----------------------------------------------------
  --
  -- On a release `v_worker_bps` is 10000 and every figure below collapses to
  -- the frozen one, which is the property that matters: a full release writes
  -- the same four ledger legs, for the same amounts, as `accept_job_delivery()`.
  --
  -- On a split the worker's commission and GST are pro-rated by the same share
  -- as the money — a worker paid 60% of the budget is charged commission on 60%
  -- of it. Flooring both makes the net larger rather than smaller, so
  -- `v_worker_net` can never go negative, and the remainder lands with the
  -- worker rather than with us.

  v_worker_bps := case v_outcome
                    when 'release'::public.dispute_outcome then 10000
                    when 'refund'::public.dispute_outcome  then 0
                    else 10000 - p_split_client_bps
                  end;

  v_worker_sum  := (v_frozen.budget_paise * v_worker_bps) / 10000;
  v_client_sum  := v_frozen.budget_paise - v_worker_sum;
  v_worker_comm := (v_frozen.worker_commission_paise * v_worker_bps) / 10000;
  v_worker_tax  := (v_frozen.worker_tax_paise * v_worker_bps) / 10000;
  v_worker_net  := v_worker_sum - v_worker_comm - v_worker_tax;

  if v_worker_net < 0 then
    -- Unreachable given the identity `worker_net = budget - commission - tax`
    -- that `open_job_payment()` checks, but a negative net would become a
    -- ledger that does not balance three statements later.
    raise exception 'dispute % computed a negative worker net (%)', p_dispute_id, v_worker_net
      using errcode = 'check_violation';
  end if;

  v_before := to_jsonb(v_case);

  -- ---- escrow -------------------------------------------------------------

  update public.escrow_holds h
     set status         = case v_outcome
                            when 'release'::public.dispute_outcome then 'released'::public.escrow_status
                            when 'refund'::public.dispute_outcome  then 'refunded'::public.escrow_status
                            else 'split'::public.escrow_status
                          end,
         released_at    = case when v_worker_sum > 0 then now() else h.released_at end,
         released_paise = v_worker_sum,
         refunded_paise = v_client_sum,
         frozen_reason  = coalesce(h.frozen_reason, 'dispute ' || p_dispute_id::text)
   where h.id = v_hold.id;

  -- ---- the ledger, for the half of it that actually moved ------------------
  --
  -- Only the worker's share leaves escrow. The client's share is still sitting
  -- in the platform's gateway account waiting on a refund call that does not
  -- exist yet, and the honest ledger for money that has not moved is no entry
  -- at all.

  if v_worker_sum > 0 then
    if v_worker_id is null then
      -- Unreachable: 0029 captures the payment and assigns the worker in one
      -- transaction, so escrow without an assignment is not representable. Said
      -- out loud because the alternative is crediting a null account.
      raise exception 'job % has escrow but nobody assigned to pay', v_job_id
        using errcode = 'no_data_found';
    end if;

    v_worker_acct := public.ensure_worker_ledger_account(v_worker_id);

    if v_worker_acct is null then
      raise exception 'worker % has no payable account', v_worker_id
        using errcode = 'no_data_found';
    end if;

    insert into public.ledger_transactions (
      kind, job_id, reference_type, reference_id, description, idempotency_key, created_by
    )
    values (
      'escrow_released'::public.ledger_txn_kind, v_job_id, 'dispute', p_dispute_id,
      'Escrow released on dispute ' || p_outcome,
      -- Keyed by job, exactly as 0030 keys it: a job's escrow is released once,
      -- whether by acceptance or by a decision.
      'escrow_released:' || v_job_id::text,
      p_admin_id
    )
    on conflict (idempotency_key) do nothing
    returning id into v_txn_id;

    if v_txn_id is not null then
      select a.id into v_acct_escrow  from public.ledger_accounts a where a.code = 'escrow';
      select a.id into v_acct_revenue from public.ledger_accounts a where a.code = 'platform_revenue';
      select a.id into v_acct_tax     from public.ledger_accounts a where a.code = 'tax_payable';

      if v_acct_escrow is null or v_acct_revenue is null or v_acct_tax is null then
        raise exception 'the platform ledger accounts are missing. Check migration 0018.'
          using errcode = 'no_data_found';
      end if;

      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, v_acct_escrow, 'credit'::public.ledger_direction, v_worker_sum, v_job_id);

      if v_worker_net > 0 then
        insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
        values (v_txn_id, v_worker_acct, 'debit'::public.ledger_direction, v_worker_net, v_job_id);
      end if;

      if v_worker_comm > 0 then
        insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
        values (v_txn_id, v_acct_revenue, 'debit'::public.ledger_direction, v_worker_comm, v_job_id);
      end if;

      if v_worker_tax > 0 then
        insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
        values (v_txn_id, v_acct_tax, 'debit'::public.ledger_direction, v_worker_tax, v_job_id);
      end if;
    end if;

    -- ---- the earning ------------------------------------------------------
    --
    -- Stamped the same way acceptance stamps it (0030): eligible 48 hours on,
    -- held 14 days if the client is new. A worker who won a dispute is paid on
    -- the same calendar as one who was simply accepted.

    insert into public.worker_earnings (
      job_id, worker_id, status, gross_paise, commission_paise, tax_paise, net_paise,
      accepted_at, eligible_at, hold_until, hold_reason
    )
    select
      v_job_id,
      v_worker_id,
      (case when coalesce(c.jobs_completed, 0) < public.setting_int('payout.new_client_job_threshold', 3)
            then 'on_hold' else 'confirmed' end)::public.earning_status,
      v_worker_sum,
      v_worker_comm,
      v_worker_tax,
      v_worker_net,
      now(),
      now() + make_interval(hours => public.setting_int('payout.eligibility_hours', 48)),
      case when coalesce(c.jobs_completed, 0) < public.setting_int('payout.new_client_job_threshold', 3)
           then now() + make_interval(days => public.setting_int('payout.new_client_hold_days', 14)) end,
      case when coalesce(c.jobs_completed, 0) < public.setting_int('payout.new_client_job_threshold', 3)
           then 'New client — held against a chargeback' end
    from (select 1) as anchor
    left join public.client_profiles c on c.profile_id = v_job.client_id
    -- Named rather than inferred: 0032's rule is that an ON CONFLICT inference
    -- spec is one of the few places plpgsql substitutes a variable and the one
    -- place a qualification is not allowed.
    on conflict on constraint worker_earnings_job_id_key do nothing;
  end if;

  -- ---- the refund the gateway has not made yet ----------------------------

  if v_client_sum > 0 then
    select p.id into v_payment_id
    from public.payments p
    where p.job_id = v_job_id
      and p.status = 'captured'::public.payment_status
    order by p.captured_at desc nulls last
    limit 1;

    if v_payment_id is null then
      raise exception 'job % has escrow but no captured payment to refund against', v_job_id
        using errcode = 'no_data_found';
    end if;

    insert into public.refunds (
      job_id, payment_id, dispute_id, amount_paise, reason, note, status, initiated_by
    )
    values (
      v_job_id, v_payment_id, p_dispute_id, v_client_sum,
      (case when v_outcome = 'split'::public.dispute_outcome
            then 'dispute_split' else 'dispute_refund' end)::public.refund_reason,
      v_note,
      -- Spec §14 puts the money back on the original method in 5–7 working days.
      -- Razorpay's refund API is not wired, so this is a queued instruction and
      -- says so by staying `pending`.
      'pending'::public.refund_status,
      p_admin_id
    );
  end if;

  -- ---- the dispute --------------------------------------------------------

  update public.disputes d
     set status           = 'resolved'::public.dispute_status,
         outcome          = v_outcome,
         split_client_bps = case when v_outcome = 'split'::public.dispute_outcome
                                 then p_split_client_bps end,
         decision_note    = v_note,
         decided_by       = p_admin_id,
         decided_at       = now(),
         closed_at        = now(),
         first_responded_at = coalesce(d.first_responded_at, now())
   where d.id = p_dispute_id
  returning * into v_case;

  -- ---- the job and the assignment -----------------------------------------

  update public.jobs j
     set status       = case when v_worker_sum > 0
                             then 'completed'::public.job_status
                             else 'cancelled'::public.job_status end,
         completed_at = case when v_worker_sum > 0 then now() else j.completed_at end,
         cancelled_at = case when v_worker_sum = 0 then now() else j.cancelled_at end
   where j.id = v_job_id;

  if v_claim.id is not null then
    update public.job_assignments a
       set status       = case when v_worker_sum > 0
                               then 'completed'::public.assignment_status
                               else 'cancelled'::public.assignment_status end,
           ended_at     = now(),
           ended_reason = 'dispute ' || p_outcome
     where a.id = v_claim.id;
  end if;

  -- Paid for, in whole or in part — so the client gets the clean files. A full
  -- refund leaves `unlocked_at` null, which is the whole access model (0030)
  -- doing its job: they are not paying, so they do not receive.
  if v_worker_sum > 0 then
    update public.delivery_files df
       set unlocked_at = now()
      from public.job_deliveries d
     where d.id = df.delivery_id
       and d.job_id = v_job_id
       and df.unlocked_at is null;
  end if;

  -- Spec §12: a disputed job's files go 30 days after the dispute closes, not
  -- the 7 days an accepted one gets. The sweeper that reads `delete_after` is
  -- still not built, so this only sets the clock.
  update public.files f
     set delete_after     = now() + make_interval(days => public.setting_int('files.retention_days_disputed', 30)),
         retention_reason = 'disputed job'
   where f.purged_at is null
     and f.id in (
       select df.file_id
       from public.delivery_files df
       join public.job_deliveries d on d.id = df.delivery_id
       where d.job_id = v_job_id
     );

  -- ---- the counters -------------------------------------------------------
  --
  -- Same reasoning as 0030: completion is the only moment these are knowable,
  -- and `worker_category_stats` is what the shortlist sorts on, so a job that
  -- completed through a dispute has to count like any other. A full refund
  -- counts as a cancellation on the client's record instead.

  if v_worker_sum > 0 then
    update public.client_profiles c
       set jobs_completed    = c.jobs_completed + 1,
           last_job_at       = now(),
           total_spend_paise = c.total_spend_paise + v_frozen.client_total_paise
     where c.profile_id = v_job.client_id;

    update public.worker_profiles w
       set jobs_completed = w.jobs_completed + 1
     where w.profile_id = v_worker_id;

    select coalesce(v_job.deadline_at is null or d.delivered_at <= v_job.deadline_at, false)
      into v_on_time
    from public.job_deliveries d
    where d.job_id = v_job_id
    order by d.attempt desc
    limit 1;

    v_on_time := coalesce(v_on_time, false);

    if v_job.category_id is not null then
      insert into public.worker_category_stats as s (
        worker_id, category_id, jobs_completed, on_time_deliveries, late_deliveries,
        last_job_at, updated_at
      )
      values (
        v_worker_id, v_job.category_id, 1,
        case when v_on_time then 1 else 0 end,
        case when v_on_time then 0 else 1 end,
        now(), now()
      )
      on conflict on constraint worker_category_stats_pkey do update
        set jobs_completed     = s.jobs_completed + 1,
            on_time_deliveries = s.on_time_deliveries + (case when v_on_time then 1 else 0 end),
            late_deliveries    = s.late_deliveries + (case when v_on_time then 0 else 1 end),
            last_job_at        = now(),
            updated_at         = now();
    end if;
  else
    update public.client_profiles c
       set jobs_cancelled        = c.jobs_cancelled + 1,
           cancellation_rate_bps = least(
             10000,
             ((c.jobs_cancelled + 1) * 10000) / greatest(c.jobs_posted, 1)
           )
     where c.profile_id = v_job.client_id;
  end if;

  -- ---- the record ---------------------------------------------------------

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    v_job_id, p_admin_id, 'admin'::public.party_role, 'dispute.resolved',
    jsonb_build_object(
      'dispute_id',       p_dispute_id,
      'outcome',          p_outcome,
      'worker_paise',     v_worker_sum,
      'client_paise',     v_client_sum,
      'worker_net_paise', v_worker_net,
      'split_client_bps', p_split_client_bps
    )
  );

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'dispute.' || p_outcome, 'disputes', p_dispute_id, v_note,
    v_before, to_jsonb(v_case), p_ip
  );

  return query select 'resolved'::text, v_case.outcome, v_worker_sum, v_client_sum, null::text;
end;
$$;

comment on function public.resolve_dispute is
  'Decides a dispute over money still in escrow: release · refund · split. The '
  'worker''s share moves through the ledger exactly as acceptance moves it; the '
  'client''s share becomes a pending refund, because Razorpay''s refund API is '
  'not wired. Refuses a job whose escrow is already settled. service_role only '
  '(0034).';

-- ============================================================================
-- apply_user_sanction — warn · suspend · ban (spec §7)
--
-- Three of `sanction_type`'s six. The other three — rating_penalty,
-- shortlist_removal, sample_resubmission — belong to the penalty system in
-- spec §6, which computes amounts and rating deltas that nothing on the
-- platform writes yet. They are refused by name rather than accepted and
-- quietly recorded as having done nothing.
--
-- Returns one row. `status` is one of:
--   applied · not_found · forbidden · invalid_type · reason_required ·
--   target_is_admin
-- ============================================================================

create or replace function public.apply_user_sanction(
  p_profile_id     uuid,
  p_admin_id       uuid,
  p_type           text,
  p_reason         text,
  p_internal_note  text default null,
  p_duration_days  integer default null,
  p_ip             inet default null
)
returns table (status text, sanction_id uuid, account_status public.account_status, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target   public.profiles%rowtype;
  v_sanction public.user_sanctions%rowtype;
  v_before   jsonb;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_note     text := nullif(btrim(coalesce(p_internal_note, '')), '');
  v_type     public.sanction_type;
  v_ends_at  timestamptz;
  v_status   public.account_status;
begin
  if p_type not in ('warning', 'suspension', 'ban') then
    return query select 'invalid_type'::text, null::uuid, null::public.account_status,
                        ('Spec §7 gives the console warn, suspend and ban. The rating and '
                         || 'shortlist penalties belong to the penalty system, which is not '
                         || 'built.')::text;
    return;
  end if;

  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::uuid, null::public.account_status, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);
  v_note   := left(v_note, 2000);
  v_type   := p_type::public.sanction_type;

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'manage_users' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::uuid, null::public.account_status, null::text;
    return;
  end if;

  select * into v_target from public.profiles p where p.id = p_profile_id for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::public.account_status, null::text;
    return;
  end if;

  -- A console account is not sanctionable from the console. Membership is
  -- granted out of band (`admin_users` has RLS on and no policies at all), so
  -- removing it is out of band too — and a support shift suspending a super
  -- admin is a way to lose the console entirely.
  if exists (
    select 1 from public.admin_users au
    where au.profile_id = p_profile_id and au.is_active
  ) then
    return query select 'target_is_admin'::text, null::uuid, v_target.status,
                        ('That account is an active console member. Revoke the membership in '
                         || 'the database first.')::text;
    return;
  end if;

  v_before := to_jsonb(v_target);

  -- A warning has no end; a ban has no end by design. Only a suspension takes a
  -- duration, and one without a duration is indefinite until someone lifts it.
  v_ends_at := case
                 when v_type = 'suspension'::public.sanction_type
                      and p_duration_days is not null and p_duration_days > 0
                 then now() + make_interval(days => p_duration_days)
               end;

  insert into public.user_sanctions (
    profile_id, type, reason, internal_note, issued_by, starts_at, ends_at
  )
  values (p_profile_id, v_type, v_reason, v_note, p_admin_id, now(), v_ends_at)
  returning * into v_sanction;

  -- A warning is a record, not a state change. Spec §7 wants it logged and the
  -- user told; nothing about their account changes, which is what makes it a
  -- warning rather than a restriction.
  v_status := case v_type
                when 'suspension'::public.sanction_type then 'suspended'::public.account_status
                when 'ban'::public.sanction_type        then 'banned'::public.account_status
                else v_target.status
              end;

  if v_status <> v_target.status then
    update public.profiles p
       set status          = v_status,
           status_reason   = v_reason,
           suspended_until = v_ends_at
     where p.id = p_profile_id
    returning * into v_target;
  end if;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'user.' || p_type, 'profiles', p_profile_id, v_reason,
    v_before, to_jsonb(v_target), p_ip
  );

  return query select 'applied'::text, v_sanction.id, v_target.status, null::text;
end;
$$;

comment on function public.apply_user_sanction is
  'Warn, suspend or ban an account: writes the sanction, moves profiles.status '
  'for the two that restrict, and writes the permanent audit row — in one '
  'transaction. Refuses a console member. service_role only (0034).';

-- ============================================================================
-- lift_user_sanction — the way back
--
-- Ships with the one above for the reason 0031's `cancel_payout_batch()` ships
-- with the builder: a state with no exit is a trap, and an account suspended by
-- a mistyped profile id would otherwise need a hand-written UPDATE against a
-- table that has INSERT, UPDATE and DELETE revoked from every API role.
--
-- The account only returns to `active` when nothing else is holding it down.
-- Two overlapping suspensions lifted one at a time must not let the first lift
-- undo the second.
--
-- Returns one row. `status` is one of:
--   lifted · not_found · forbidden · reason_required · already_lifted
-- ============================================================================

create or replace function public.lift_user_sanction(
  p_sanction_id uuid,
  p_admin_id    uuid,
  p_reason      text,
  p_ip          inet default null
)
returns table (status text, account_status public.account_status, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sanction public.user_sanctions%rowtype;
  v_target   public.profiles%rowtype;
  v_before   jsonb;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_holding  boolean;
begin
  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::public.account_status, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'manage_users' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::public.account_status, null::text;
    return;
  end if;

  select * into v_sanction
  from public.user_sanctions s
  where s.id = p_sanction_id
  for update;

  if not found then
    return query select 'not_found'::text, null::public.account_status, null::text;
    return;
  end if;

  if v_sanction.lifted_at is not null then
    return query select 'already_lifted'::text, null::public.account_status, null::text;
    return;
  end if;

  select * into v_target from public.profiles p where p.id = v_sanction.profile_id for update;
  v_before := to_jsonb(v_target);

  update public.user_sanctions s
     set lifted_at = now(),
         lifted_by = p_admin_id
   where s.id = p_sanction_id;

  -- Anything else still restricting this account, now that this one is lifted.
  select exists (
    select 1
    from public.user_sanctions s
    where s.profile_id = v_sanction.profile_id
      and s.id <> p_sanction_id
      and s.lifted_at is null
      and s.type in ('suspension'::public.sanction_type, 'ban'::public.sanction_type)
      and (s.ends_at is null or s.ends_at > now())
  ) into v_holding;

  if not v_holding
     and v_target.status in ('suspended'::public.account_status, 'banned'::public.account_status) then
    update public.profiles p
       set status          = 'active'::public.account_status,
           status_reason   = null,
           suspended_until = null
     where p.id = v_sanction.profile_id
    returning * into v_target;
  end if;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'user.sanction_lifted', 'user_sanctions', p_sanction_id, v_reason,
    v_before, to_jsonb(v_target), p_ip
  );

  return query select 'lifted'::text, v_target.status, null::text;
end;
$$;

comment on function public.lift_user_sanction is
  'Lifts one sanction and returns the account to active only if nothing else is '
  'still holding it down. service_role only (0034).';

-- ============================================================================
-- review_payout_batch — the review spec §7 puts before each run
--
-- 0031 leaves an assembled batch at `closed` and says why: `under_review` and
-- `processing` belong to the disbursement step. This is the first half of that
-- — a person reading the batch and saying it may go — and it moves `closed` →
-- `under_review`, which is where the disbursement step will pick it up.
--
-- The `cancel` branch delegates to 0031's `cancel_payout_batch()` rather than
-- reimplementing the unwind. What it adds is the permission check: 0031's
-- function takes an actor id and writes the audit row but verifies nothing,
-- because at the time its only caller was a cron.
--
-- Returns one row. `status` is one of:
--   reviewed · not_found · forbidden · invalid_decision · reason_required ·
--   not_reviewable
-- ============================================================================

create or replace function public.review_payout_batch(
  p_batch_id uuid,
  p_admin_id uuid,
  p_decision text,
  p_reason   text,
  p_ip       inet default null
)
returns table (status text, batch_status public.payout_batch_status, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch  public.payout_batches%rowtype;
  v_before jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_decision not in ('approve', 'cancel') then
    return query select 'invalid_decision'::text, null::public.payout_batch_status, null::text;
    return;
  end if;

  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::public.payout_batch_status, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'manage_payouts' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::public.payout_batch_status, null::text;
    return;
  end if;

  if p_decision = 'cancel' then
    -- 0031 owns the unwind: earnings back to `confirmed`, payout lines removed,
    -- payouts cancelled, and its own audit row. It raises rather than returning
    -- a status, so the two states it refuses are checked here first and read as
    -- sentences instead.
    select * into v_batch from public.payout_batches b where b.id = p_batch_id;

    if not found then
      return query select 'not_found'::text, null::public.payout_batch_status, null::text;
      return;
    end if;

    if v_batch.status in ('processing'::public.payout_batch_status,
                          'completed'::public.payout_batch_status,
                          'failed'::public.payout_batch_status) then
      return query select 'not_reviewable'::text, v_batch.status,
                          format('This batch is %s and cannot be unbuilt.', v_batch.status)::text;
      return;
    end if;

    v_batch := public.cancel_payout_batch(p_batch_id, p_admin_id, v_reason);

    return query select 'reviewed'::text, v_batch.status, null::text;
    return;
  end if;

  select * into v_batch from public.payout_batches b where b.id = p_batch_id for update;

  if not found then
    return query select 'not_found'::text, null::public.payout_batch_status, null::text;
    return;
  end if;

  -- `open` is a batch the builder is still filling — the per-run worker cap was
  -- hit and the next run carries on. Approving one would sign off on a total
  -- that is about to change.
  if v_batch.status <> 'closed'::public.payout_batch_status then
    return query select 'not_reviewable'::text, v_batch.status,
                        case v_batch.status
                          when 'open'::public.payout_batch_status then
                            'This batch is still being filled. It can be approved once the run that closes it finishes.'
                          else
                            format('This batch is already %s.', v_batch.status)
                        end::text;
    return;
  end if;

  v_before := to_jsonb(v_batch);

  update public.payout_batches b
     set status      = 'under_review'::public.payout_batch_status,
         reviewed_by = p_admin_id,
         reviewed_at = now()
   where b.id = p_batch_id
  returning * into v_batch;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'payout_batch.approved', 'payout_batches', p_batch_id, v_reason,
    v_before, to_jsonb(v_batch), p_ip
  );

  return query select 'reviewed'::text, v_batch.status, null::text;
end;
$$;

comment on function public.review_payout_batch is
  'The batch review spec §7 puts before each run: closed → under_review, or a '
  'delegated cancel. service_role only (0034).';

-- ============================================================================
-- retry_failed_payout — spec §14's failed-payout queue
--
-- "Money returns to escrow, worker sees a clear banner, auto-retry next cycle
-- once details change."
--
-- The retry is not a second attempt at the same payout row — it is the earnings
-- going back to `confirmed`, where `build_payout_batch()` finds everything
-- mature with no lower bound on `eligible_at` and picks them up on the next
-- cycle. That is the same mechanism 0031 relies on for "anything short rolls
-- forward", and it means the retry gets the KYC gate for free: a worker whose
-- destination is still wrong is skipped again rather than paid again.
--
-- No ledger entry, for the same reason 0031 writes none: nothing ever left
-- `worker_payable`, so nothing has to come back to it.
--
-- Returns one row. `status` is one of:
--   returned · not_found · forbidden · reason_required · not_failed
-- ============================================================================

create or replace function public.retry_failed_payout(
  p_payout_id uuid,
  p_admin_id  uuid,
  p_reason    text,
  p_ip        inet default null
)
returns table (status text, earnings_returned integer, amount_paise bigint, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payout   public.payouts%rowtype;
  v_before   jsonb;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_returned integer := 0;
begin
  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::integer, null::bigint, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'manage_payouts' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::integer, null::bigint, null::text;
    return;
  end if;

  select * into v_payout from public.payouts p where p.id = p_payout_id for update;

  if not found then
    return query select 'not_found'::text, null::integer, null::bigint, null::text;
    return;
  end if;

  if v_payout.status <> 'failed'::public.payout_status then
    return query select 'not_failed'::text, null::integer, null::bigint,
                        format('This payout is %s. Only a failed one returns to the cycle.',
                               v_payout.status)::text;
    return;
  end if;

  v_before := to_jsonb(v_payout);

  update public.worker_earnings e
     set status    = 'confirmed'::public.earning_status,
         payout_id = null
   where e.payout_id = p_payout_id
     and e.status = 'in_payout'::public.earning_status;

  get diagnostics v_returned = row_count;

  -- The lines go with the payout they described. The earnings themselves keep
  -- their own `eligible_at` and `hold_until`, so they return to the queue at the
  -- same place in it.
  delete from public.payout_items pi where pi.payout_id = p_payout_id;

  update public.payouts p
     set status = 'cancelled'::public.payout_status
   where p.id = p_payout_id
  returning * into v_payout;

  -- The batch's totals no longer describe what it paid.
  if v_payout.batch_id is not null then
    update public.payout_batches b
       set total_paise = greatest(b.total_paise - v_payout.amount_paise, 0),
           item_count  = greatest(b.item_count - v_returned, 0)
     where b.id = v_payout.batch_id;
  end if;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'payout.returned_to_cycle', 'payouts', p_payout_id, v_reason,
    v_before, to_jsonb(v_payout), p_ip
  );

  return query select 'returned'::text, v_returned, v_payout.amount_paise, null::text;
end;
$$;

comment on function public.retry_failed_payout is
  'Returns a failed payout''s earnings to `confirmed` so the next cycle picks '
  'them up (spec §14). Writes no ledger entry — nothing ever left worker '
  'payable. service_role only (0034).';

-- ============================================================================
-- The retention window a disputed job gets
--
-- Spec §12 gives an accepted job 7 days and a disputed one 30. 0018 seeded the
-- first; nothing needed the second until there was a function that closed a
-- dispute.
-- ============================================================================

insert into public.platform_settings (key, value, value_type, description, is_public)
values (
  'files.retention_days_disputed', '30', 'int',
  'Days a disputed job''s files are kept after the dispute closes (spec §12).', true
)
on conflict (key) do nothing;

-- ============================================================================
-- Grants
--
-- Four of the five decide where money goes, and the fifth decides whether
-- someone may keep using the platform. None is callable from a browser: the
-- Server Actions in `lib/admin/` hold the service-role key and each one
-- re-establishes who is asking before it runs — which is what the permission
-- check at the top of every function above is checking again.
-- ============================================================================

revoke execute on function public.resolve_dispute(uuid, uuid, text, text, integer, inet)
  from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, integer, inet)
  to service_role;

revoke execute on function public.apply_user_sanction(uuid, uuid, text, text, text, integer, inet)
  from public, anon, authenticated;
grant execute on function public.apply_user_sanction(uuid, uuid, text, text, text, integer, inet)
  to service_role;

revoke execute on function public.lift_user_sanction(uuid, uuid, text, inet)
  from public, anon, authenticated;
grant execute on function public.lift_user_sanction(uuid, uuid, text, inet) to service_role;

revoke execute on function public.review_payout_batch(uuid, uuid, text, text, inet)
  from public, anon, authenticated;
grant execute on function public.review_payout_batch(uuid, uuid, text, text, inet) to service_role;

revoke execute on function public.retry_failed_payout(uuid, uuid, text, inet)
  from public, anon, authenticated;
grant execute on function public.retry_failed_payout(uuid, uuid, text, inet) to service_role;
