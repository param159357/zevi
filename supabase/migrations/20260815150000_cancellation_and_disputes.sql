-- ============================================================================
-- Zevi 0036 — the cancellation tiers, and something that raises a dispute
--
-- Two of spec §5's endings that the platform has been missing, and they are one
-- migration because they are one decision seen from two distances: what happens
-- to money held in escrow when a job does not finish the way it was meant to.
--
--   open_dispute()              spec §11's "both sides can raise a dispute"
--   respond_to_dispute()        the other side's 24 hours
--   request_job_cancellation()  spec §5's five-row table
--   resolve_dispute()           replaced — now honours the >50% tier's cap
--
-- ---------------------------------------------------------------------------
-- The tiers, and where each one lands
--
--   | When                     | Refund                            | Here      |
--   |--------------------------|-----------------------------------|-----------|
--   | No worker assigned yet   | Full, instant, no fee             | immediate |
--   | ≤30% of deadline elapsed | Full, minus ₹15                   | immediate |
--   | 31–50% elapsed           | 80% client / 20% worker, minus ₹15| immediate |
--   | >50% elapsed             | Admin assesses, client capped 70% | a dispute |
--   | After delivery           | No percentage refund              | refused   |
--
-- The first three are spec §11's layer 1 — "cancellation inside the time tiers
-- → rules apply automatically" — so they are applied in one transaction with no
-- person involved. The fourth is not a tier with a formula, it is a tier with a
-- *reviewer*, and this platform already has exactly one record for "an admin
-- must decide how to divide escrow": a dispute. So a late cancellation opens
-- one, carrying the 70% ceiling with it on `disputes.client_refund_cap_bps`,
-- and `resolve_dispute()` refuses to go past it. A cap that lived only in the
-- spec's prose is a cap a tired reviewer types past at four in the afternoon;
-- this is the same discipline KYC's unappealable block is written with.
--
-- The fifth is refused with a sentence naming the three doors that *are* open.
-- Delivery ends the cancellation path however little of the window ran.
--
-- ---------------------------------------------------------------------------
-- What moves through the ledger, and what does not
--
-- Exactly the rule 0034 set, because the constraint behind it has not changed:
-- Razorpay's refund API is still unwired, so the client's money is still sitting
-- in the platform's gateway account.
--
--   the worker's share   moves. escrow → worker payable + revenue + tax, the
--                        same four legs `accept_job_delivery()` writes, and a
--                        `worker_earnings` row on the same payout calendar.
--   the ₹15 fee          moves. escrow → platform revenue. It is money we are
--                        keeping rather than sending back, which is a
--                        reallocation between our own accounts exactly as the
--                        worker's share is.
--   the client's refund  does NOT move. A `refunds` row lands `pending` and no
--                        ledger entry is written, because nothing has left the
--                        building. The escrow account's balance therefore stays
--                        equal to what the platform actually holds for that
--                        client, which is what makes the gap between
--                        `escrow_holds` and the ledger a *seam* rather than
--                        drift.
--
-- No GST on the fee. Spec §8 applies 18% "on commission from both sides"; the
-- ₹15 is listed under "Other fees", separately, and inventing a tax line for it
-- would put a number in `tax_payable` that no CA asked for.
--
-- ---------------------------------------------------------------------------
-- What is deliberately not built
--
--   * Layers 1, 2 and 4 of spec §11. Spec §16 cuts the four-layer system down to
--     "handle disputes personally at first", so there is no auto-resolver, no
--     24-hour self-settlement screen and no instant 50/50 under ₹300. The tables
--     for all three exist (0015) and stay empty.
--   * Appeals. One appeal, 48 hours, new evidence only — a second decision flow,
--     and `dispute_appeals` is ready for it whenever the first one has been used
--     in anger.
--   * The ₹15 dispute fee. Still 0, still for 0034's reason: charging it needs a
--     `worker_adjustments` row or a ledger movement against a party, and nothing
--     on the platform writes an adjustment yet.
--   * Worker-side cancellation. Spec §5's table is the *client's*; a worker who
--     walks away is spec §6's abandonment, which carries a rating delta, a debit
--     and a next-job cap that nothing computes yet. A worker who wants out
--     raises a dispute, which is the door spec §11 gives them.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The numbers the tiers are made of
--
-- Settings rather than constants for the same reason the auto-accept window is:
-- they are policy, and policy moves. What is NOT a setting is the shape —
-- `request_job_cancellation()` reads these once, at the moment of the decision,
-- and stores the tier and the elapsed fraction it actually used on the
-- `cancellations` row. A later change to a boundary can never rewrite what a
-- client was told.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('cancellation.early_max_bps', '3000', 'int',
   'Up to this much of the worker''s window elapsed: full refund less the fee (spec §5).', true),
  ('cancellation.mid_max_bps', '5000', 'int',
   'Up to this much elapsed: 80/20 split less the fee (spec §5).', true),
  ('cancellation.mid_worker_bps', '2000', 'int',
   'The worker''s share in the middle tier: 20% (spec §5).', true),
  ('cancellation.late_client_cap_bps', '7000', 'int',
   'Past half the window an admin assesses, and cannot refund the client more than this (spec §5).', true),
  ('dispute.response_hours', '24', 'int',
   'How long the other side has to file their statement (spec §11).', true),
  ('dispute.post_acceptance_hours', '48', 'int',
   'How long after accepting a delivery a client may still raise a dispute (spec §11).', true)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- The fee, from the versioned table rather than from a literal
--
-- `fee_schedule` is versioned the way `commission_slabs` and `tax_rates` are: a
-- rate is never updated in place, a new row is inserted and the old one closed.
-- So the lookup is "what applied at this moment", and a cancellation in March is
-- still explicable in September.
--
-- `waived_below_paise` is honoured because the column exists to be honoured —
-- nothing sets it today, and the day someone decides a ₹149 job should not carry
-- a ₹15 fee, this is where that decision already works.
-- ----------------------------------------------------------------------------

create or replace function public.fee_amount_paise(
  p_code   text,
  p_amount bigint default null,
  p_at     timestamptz default now()
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select case
              when f.waived_below_paise is not null
                   and p_amount is not null
                   and p_amount < f.waived_below_paise
              then 0
              else f.amount_paise
            end
     from public.fee_schedule f
     where f.code = p_code
       and f.effective_from <= p_at
       and (f.effective_to is null or f.effective_to > p_at)
     limit 1),
    0
  );
$$;

comment on function public.fee_amount_paise is
  'The fixed fee in effect for a code at a moment, 0 if none is (0036). Honours '
  'waived_below_paise so a threshold, once set, needs no code change.';

grant execute on function public.fee_amount_paise(text, bigint, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- The ceiling a late cancellation carries onto its dispute
--
-- Null on an ordinary dispute, which is every dispute anyone raises directly:
-- spec §11 puts no cap on what a reviewer may decide when the complaint is about
-- the work. It is only the >50% *cancellation* that spec §5 caps, and the cap
-- belongs to that case rather than to the reviewer's memory.
-- ----------------------------------------------------------------------------

alter table public.disputes
  add column client_refund_cap_bps integer
    check (client_refund_cap_bps is null or client_refund_cap_bps between 0 and 10000);

comment on column public.disputes.client_refund_cap_bps is
  'Set when a >50% cancellation opened this case (spec §5): the most of the '
  'budget that may go back to the client. resolve_dispute() refuses to exceed it.';

-- ============================================================================
-- open_dispute — spec §11's "both sides can raise a dispute"
--
-- Money freezes the moment a dispute opens, and that sentence is three writes:
-- the escrow hold moves `held → frozen` (which `accept_job_delivery()` already
-- refuses to release), the job moves to `disputed`, and any attempt still
-- awaiting review moves to `disputed` too — which is what stops the auto-accept
-- clock, because `job_deliveries_auto_accept_idx` is partial on `pending_review`
-- and the sweep stops seeing the row. Without that third write the sweep would
-- reach this job every hour and fail on the frozen hold, forever.
--
-- The windows are spec §11's, and they differ by side:
--
--   client   from delivery until 48 hours after acceptance
--   worker   from assignment until payout
--
-- The client's window deliberately extends past acceptance, and the case that
-- lands there cannot be decided yet: `resolve_dispute()` refuses a job whose
-- escrow is settled, because reversing a paid earning is a flow that is not
-- built. Opening it anyway is the honest half — the complaint is recorded, both
-- statements are collected, and the console says plainly why the money cannot
-- move — rather than telling a client inside their stated window that the door
-- they were promised does not exist.
--
-- Returns one row. `status` is one of:
--   opened · not_found · forbidden · already_open · outside_window ·
--   reason_required · statement_required
-- ============================================================================

create or replace function public.open_dispute(
  p_job_id         uuid,
  p_actor_id       uuid,
  p_reason         text,
  p_statement      text,
  p_client_cap_bps integer default null
)
returns table (status text, dispute_id uuid, amount_paise bigint, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      public.jobs%rowtype;
  v_hold     public.escrow_holds%rowtype;
  v_case     public.disputes%rowtype;
  v_delivery public.job_deliveries%rowtype;

  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_statement text := nullif(btrim(coalesce(p_statement, '')), '');
  v_role      public.party_role;
  v_other     uuid;
  v_amount    bigint := 0;
  v_accepted  timestamptz;
  v_paid      boolean;
begin
  if v_reason is null or char_length(v_reason) < 10 then
    return query select 'reason_required'::text, null::uuid, null::bigint,
                        'A dispute needs at least ten characters saying what it is about.'::text;
    return;
  end if;

  -- Mirrors `dispute_statements_body_check`. Spec §11 requires a statement from
  -- each side and caps it at 500 characters; the floor is the column's.
  if v_statement is null or char_length(v_statement) < 20 then
    return query select 'statement_required'::text, null::uuid, null::bigint,
                        'Your statement needs at least twenty characters.'::text;
    return;
  end if;

  v_reason    := left(v_reason, 500);
  v_statement := left(v_statement, 500);

  select * into v_job from public.jobs j where j.id = p_job_id for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::bigint, null::text;
    return;
  end if;

  if p_actor_id = v_job.client_id then
    v_role  := 'client'::public.party_role;
    v_other := v_job.assigned_worker_id;
  elsif p_actor_id is not null and p_actor_id = v_job.assigned_worker_id then
    v_role  := 'worker'::public.party_role;
    v_other := v_job.client_id;
  else
    return query select 'forbidden'::text, null::uuid, null::bigint, null::text;
    return;
  end if;

  -- `disputes_one_live_idx` would raise on this; catching it here means a
  -- sentence instead of a unique-violation, and the two sides racing to raise
  -- the same complaint is a likely event rather than a rare one.
  if exists (
    select 1 from public.disputes d
    where d.job_id = p_job_id
      and d.status not in ('resolved'::public.dispute_status, 'closed'::public.dispute_status)
  ) then
    return query select 'already_open'::text, null::uuid, null::bigint,
                        'There is already an open case on this job. A second complaint joins it.'::text;
    return;
  end if;

  -- ---- the windows --------------------------------------------------------

  select * into v_delivery
  from public.job_deliveries d
  where d.job_id = p_job_id
  order by d.attempt desc
  limit 1;

  if v_role = 'client'::public.party_role then
    -- "Client window: delivery until 48h after acceptance."
    if v_delivery.id is null then
      return query select 'outside_window'::text, null::uuid, null::bigint,
                          ('Nothing has been delivered on this job yet, so there is nothing to '
                           || 'dispute. Cancel it instead, or wait for the deadline.')::text;
      return;
    end if;

    select d.accepted_at into v_accepted
    from public.job_deliveries d
    where d.job_id = p_job_id
      and d.status = 'accepted'::public.delivery_status
    order by d.accepted_at desc nulls last
    limit 1;

    if v_accepted is not null
       and now() > v_accepted
                   + make_interval(hours => public.setting_int('dispute.post_acceptance_hours', 48)) then
      return query select 'outside_window'::text, null::uuid, null::bigint,
                          ('The 48 hours to raise a dispute after accepting this work have '
                           || 'passed. Write to support if something is still wrong.')::text;
      return;
    end if;
  else
    -- "Worker window: assignment until payout."
    if v_job.assigned_at is null then
      return query select 'outside_window'::text, null::uuid, null::bigint,
                          'You are not assigned to this job.'::text;
      return;
    end if;

    select exists (
      select 1 from public.worker_earnings e
      where e.job_id = p_job_id
        and e.status in ('in_payout'::public.earning_status, 'paid'::public.earning_status)
    ) into v_paid;

    if v_paid then
      return query select 'outside_window'::text, null::uuid, null::bigint,
                          ('You have already been paid for this job, so the dispute window has '
                           || 'closed. Write to support.')::text;
      return;
    end if;
  end if;

  -- ---- money freezes ------------------------------------------------------

  select * into v_hold
  from public.escrow_holds h
  where h.job_id = p_job_id
    and h.status in ('held'::public.escrow_status, 'frozen'::public.escrow_status)
  for update;

  if v_hold.id is not null then
    v_amount := v_hold.amount_paise;

    update public.escrow_holds h
       set status        = 'frozen'::public.escrow_status,
           frozen_at     = coalesce(h.frozen_at, now()),
           frozen_reason = coalesce(h.frozen_reason, 'dispute raised by the ' || v_role)
     where h.id = v_hold.id;
  end if;

  -- ---- the case -----------------------------------------------------------

  insert into public.disputes (
    job_id, raised_by, raised_by_role, layer, status, reason_summary, amount_paise,
    response_due_at, first_response_due_at, decision_due_at, client_refund_cap_bps
  )
  values (
    p_job_id, p_actor_id, v_role,
    -- V1 is layer 3 only (spec §16): a human reads it and decides. The other
    -- three layers have tables and no code.
    'admin_review'::public.dispute_layer,
    'awaiting_response'::public.dispute_status,
    v_reason, v_amount,
    now() + make_interval(hours => public.setting_int('dispute.response_hours', 24)),
    now() + make_interval(hours => public.setting_int('dispute.first_response_hours', 48)),
    now() + make_interval(days  => public.setting_int('dispute.decision_days', 5)),
    p_client_cap_bps
  )
  returning * into v_case;

  insert into public.dispute_statements (dispute_id, author_id, author_role, body)
  values (v_case.id, p_actor_id, v_role, v_statement);

  -- ---- the job and the clock ----------------------------------------------

  update public.jobs j
     set status = 'disputed'::public.job_status
   where j.id = p_job_id;

  update public.job_deliveries d
     set status = 'disputed'::public.delivery_status
   where d.job_id = p_job_id
     and d.status = 'pending_review'::public.delivery_status;

  -- ---- spec §11's "track dispute rate per user" ---------------------------
  --
  -- The counters, which are the tracking. `dispute_rate_bps` is left alone: a
  -- rate needs a denominator and the spec names none, so inventing one here
  -- would put a number on an admin screen that means whatever this line happened
  -- to divide by.
  --
  -- Named constraints rather than inferred columns — 0032's rule is that an ON
  -- CONFLICT inference spec is the one place plpgsql substitutes a variable and
  -- the one place a qualification is not syntactically allowed.

  insert into public.user_private_stats as s (profile_id, disputes_raised)
  values (p_actor_id, 1)
  on conflict on constraint user_private_stats_pkey
  do update set disputes_raised = s.disputes_raised + 1;

  if v_other is not null then
    insert into public.user_private_stats as s (profile_id, disputes_against)
    values (v_other, 1)
    on conflict on constraint user_private_stats_pkey
    do update set disputes_against = s.disputes_against + 1;
  end if;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id, p_actor_id, v_role, 'dispute.opened',
    jsonb_build_object(
      'dispute_id',   v_case.id,
      'amount_paise', v_amount,
      'raised_by',    v_role,
      'cap_bps',      p_client_cap_bps
    )
  );

  return query select 'opened'::text, v_case.id, v_amount,
                      case when v_amount = 0
                           then 'Nothing is in escrow on this job, so a decision here cannot move money.'
                      end::text;
end;
$$;

comment on function public.open_dispute is
  'Raises a dispute (spec §11): freezes escrow, stops the auto-accept clock, '
  'records the first statement and starts the three deadlines — in one '
  'transaction. Enforces each side''s window. service_role only (0036).';

-- ============================================================================
-- respond_to_dispute — the other side's 24 hours
--
-- Its own function rather than the INSERT policy 0015 wrote, for the reason 0030
-- gave when it dropped the three delivery policies: the insert moves a row the
-- same statement cannot finish. A statement from the other side is also the
-- moment the case becomes decidable, and `disputes` has UPDATE revoked from
-- `authenticated`, so a browser could write half of this and none of the rest.
--
-- No deadline is enforced on it. Spec §11 gives the other side 24 hours, and
-- what expires at 24 hours is the *waiting*, not the right to speak — a reviewer
-- who has not decided yet should read a statement that arrives late rather than
-- have it refused on their behalf.
--
-- Returns one row. `status` is one of:
--   recorded · not_found · forbidden · already_decided · statement_required
-- ============================================================================

create or replace function public.respond_to_dispute(
  p_dispute_id uuid,
  p_actor_id   uuid,
  p_statement  text
)
returns table (status text, statement_id uuid, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case      public.disputes%rowtype;
  v_job       public.jobs%rowtype;
  v_statement text := nullif(btrim(coalesce(p_statement, '')), '');
  v_role      public.party_role;
  v_job_id    uuid;
  v_new       uuid;
begin
  if v_statement is null or char_length(v_statement) < 20 then
    return query select 'statement_required'::text, null::uuid,
                        'Your statement needs at least twenty characters.'::text;
    return;
  end if;

  v_statement := left(v_statement, 500);

  select d.job_id into v_job_id from public.disputes d where d.id = p_dispute_id;

  if v_job_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  -- Jobs first, then the dispute — the lock order every money function here
  -- takes, kept even though this one moves none.
  select * into v_job from public.jobs j where j.id = v_job_id for update;
  select * into v_case from public.disputes d where d.id = p_dispute_id for update;

  if p_actor_id = v_job.client_id then
    v_role := 'client'::public.party_role;
  elsif p_actor_id is not null and p_actor_id = v_job.assigned_worker_id then
    v_role := 'worker'::public.party_role;
  else
    return query select 'forbidden'::text, null::uuid, null::text;
    return;
  end if;

  if v_case.status in ('resolved'::public.dispute_status, 'closed'::public.dispute_status)
     or v_case.outcome is not null then
    return query select 'already_decided'::text, null::uuid,
                        'This case has already been decided.'::text;
    return;
  end if;

  insert into public.dispute_statements (dispute_id, author_id, author_role, body)
  values (p_dispute_id, p_actor_id, v_role, v_statement)
  returning id into v_new;

  -- Both sides have now spoken, so it belongs to a reviewer rather than to a
  -- waiting room. A second statement from the side that raised it leaves the
  -- status where it is.
  if v_case.status = 'awaiting_response'::public.dispute_status
     and v_role <> v_case.raised_by_role then
    update public.disputes d
       set status = 'admin_review'::public.dispute_status
     where d.id = p_dispute_id;
  end if;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    v_job_id, p_actor_id, v_role, 'dispute.statement',
    jsonb_build_object('dispute_id', p_dispute_id, 'statement_id', v_new)
  );

  return query select 'recorded'::text, v_new, null::text;
end;
$$;

comment on function public.respond_to_dispute is
  'The other side''s statement (spec §11), and the move to admin_review that '
  'comes with it. service_role only (0036).';

-- ============================================================================
-- request_job_cancellation — spec §5's table, applied
--
-- Lock order is jobs → escrow → payments, the same order 0029's three functions
-- and 0030's four take. Two orders deadlock the first time a client cancels
-- while a webhook settles.
--
-- Returns one row. `status` is one of:
--   cancelled · assessment_opened · not_found · forbidden · reason_required ·
--   post_delivery · not_cancellable · already_disputed · not_priced
-- ============================================================================

create or replace function public.request_job_cancellation(
  p_job_id    uuid,
  p_client_id uuid,
  p_reason    text
)
returns table (
  status              text,
  tier                public.cancellation_tier,
  elapsed_bps         integer,
  client_refund_paise bigint,
  worker_paise        bigint,
  fee_paise           bigint,
  dispute_id          uuid,
  detail              text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job    public.jobs%rowtype;
  v_frozen public.job_financials%rowtype;
  v_hold   public.escrow_holds%rowtype;
  v_claim  public.job_assignments%rowtype;
  v_cancel public.cancellations%rowtype;

  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_tier    public.cancellation_tier;
  v_elapsed integer;
  v_window  double precision;

  v_early_max  integer;
  v_mid_max    integer;
  v_mid_worker integer;
  v_cap_bps    integer;
  v_share_bps  integer := 0;

  v_worker_sum  bigint := 0;
  v_worker_comm bigint := 0;
  v_worker_tax  bigint := 0;
  v_worker_net  bigint := 0;
  v_fee         bigint := 0;
  v_refund      bigint := 0;

  v_delivered      boolean;
  v_open_status    text;
  v_open_detail    text;
  v_dispute        uuid;
  v_payment_id     uuid;
  v_txn_id         uuid;
  v_worker_acct    uuid;
  v_worker_id      uuid;

  v_acct_escrow  uuid;
  v_acct_revenue uuid;
  v_acct_tax     uuid;
begin
  -- Mirrors the CHECK on `cancellations.reason`, so a client reads a sentence
  -- rather than a constraint name. Spec §14 logs a reason on every refund.
  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::public.cancellation_tier, null::integer,
                        null::bigint, null::bigint, null::bigint, null::uuid, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);

  select * into v_job from public.jobs j where j.id = p_job_id for update;

  if not found then
    return query select 'not_found'::text, null::public.cancellation_tier, null::integer,
                        null::bigint, null::bigint, null::bigint, null::uuid, null::text;
    return;
  end if;

  -- Spec §5's table is the client's. The actor is checked under the lock rather
  -- than trusted from the session that called us.
  if v_job.client_id <> p_client_id then
    return query select 'forbidden'::text, null::public.cancellation_tier, null::integer,
                        null::bigint, null::bigint, null::bigint, null::uuid, null::text;
    return;
  end if;

  if exists (
    select 1 from public.disputes d
    where d.job_id = p_job_id
      and d.status not in ('resolved'::public.dispute_status, 'closed'::public.dispute_status)
  ) then
    return query select 'already_disputed'::text, null::public.cancellation_tier, null::integer,
                        null::bigint, null::bigint, null::bigint, null::uuid,
                        ('This job already has an open case. It will be decided there rather '
                         || 'than cancelled.')::text;
    return;
  end if;

  if v_job.status in ('completed'::public.job_status, 'cancelled'::public.job_status,
                      'expired'::public.job_status, 'rejected'::public.job_status) then
    return query select 'not_cancellable'::text, null::public.cancellation_tier, null::integer,
                        null::bigint, null::bigint, null::bigint, null::uuid,
                        format('This job is already %s.', v_job.status)::text;
    return;
  end if;

  -- ---- which row of the table ---------------------------------------------

  select exists (
    select 1 from public.job_deliveries d where d.job_id = p_job_id
  ) into v_delivered;

  -- Checked before the clock, deliberately. Spec §5's last row is about
  -- delivery, not about elapsed time: a worker who sent the work on day two has
  -- delivered, and the client has accept, revise or dispute rather than a
  -- percentage.
  if v_delivered
     or v_job.status in ('delivered'::public.job_status,
                         'revision_requested'::public.job_status) then
    return query select 'post_delivery'::text, 'post_delivery'::public.cancellation_tier,
                        null::integer, null::bigint, null::bigint, null::bigint, null::uuid,
                        ('Work has already been delivered on this job, so there is no '
                         || 'percentage refund. Accept it, ask for the free revision, or raise '
                         || 'a dispute.')::text;
    return;
  end if;

  v_early_max  := public.setting_int('cancellation.early_max_bps', 3000);
  v_mid_max    := public.setting_int('cancellation.mid_max_bps', 5000);
  v_mid_worker := public.setting_int('cancellation.mid_worker_bps', 2000);
  v_cap_bps    := public.setting_int('cancellation.late_client_cap_bps', 7000);

  if v_job.assigned_at is null then
    v_tier    := 'pre_assignment'::public.cancellation_tier;
    v_elapsed := null;
  else
    -- "% of deadline elapsed", measured from **assignment**. The deadline is set
    -- at posting, but nobody is working against it until someone is picked, and
    -- the middle tier exists to pay a worker for time already spent. A job that
    -- sat open for a fortnight would otherwise land past half on its first real
    -- day of work.
    --
    -- Floored, matching `lib/cancellations/tiers.ts`: a boundary is crossed once
    -- a whole basis point has passed, so the quantisation falls the client's way.
    v_window := extract(epoch from (v_job.deadline_at - v_job.assigned_at));

    if v_job.deadline_at is null or v_window <= 0 then
      -- `jobs_publishable` requires a deadline on every status past draft, so
      -- this is unreachable. The safe way to be wrong is the tier a person looks
      -- at, not the one that refunds automatically.
      v_elapsed := 10000;
    else
      v_elapsed := least(greatest(
        floor(extract(epoch from (now() - v_job.assigned_at)) * 10000 / v_window)::integer,
        0), 10000);
    end if;

    v_tier := case
                when v_elapsed <= v_early_max then 'early'::public.cancellation_tier
                when v_elapsed <= v_mid_max   then 'mid'::public.cancellation_tier
                else 'late'::public.cancellation_tier
              end;
  end if;

  -- ---- the tier that is not a formula --------------------------------------
  --
  -- Past half the window the spec stops giving a rule and names a person. This
  -- opens the case they will decide, carrying the 70% ceiling onto it, and
  -- changes nothing else: the job stays where it is, escrow freezes, and a
  -- reviewer reads it.

  if v_tier = 'late'::public.cancellation_tier then
    select o.status, o.dispute_id, o.detail
      into v_open_status, v_dispute, v_open_detail
    from public.open_dispute(
      p_job_id,
      p_client_id,
      format('Cancellation requested with %s%% of the deadline elapsed', v_elapsed / 100),
      v_reason,
      v_cap_bps
    ) o;

    if v_open_status <> 'opened' then
      -- Its refusals are all sentences already — a statement too short, a case
      -- already open — so they are handed straight back rather than flattened
      -- into one of ours.
      return query select v_open_status, v_tier, v_elapsed,
                          null::bigint, null::bigint, null::bigint, null::uuid, v_open_detail;
      return;
    end if;

    return query select 'assessment_opened'::text, v_tier, v_elapsed,
                        null::bigint, null::bigint, null::bigint, v_dispute,
                        format('More than half the deadline has gone, so one of us decides this '
                               'one. You will get back at most %s%% of the budget.',
                               v_cap_bps / 100)::text;
    return;
  end if;

  -- ---- the money, for the tiers that have a formula ------------------------

  select * into v_claim
  from public.job_assignments a
  where a.job_id = p_job_id
    and a.status = 'active'::public.assignment_status;

  v_worker_id := coalesce(v_claim.worker_id, v_job.assigned_worker_id);

  select * into v_hold
  from public.escrow_holds h
  where h.job_id = p_job_id
    and h.status in ('held'::public.escrow_status, 'frozen'::public.escrow_status)
  for update;

  -- No hold means nothing was ever charged, which is the pre-assignment tier:
  -- payment happens at selection and nowhere else (spec §4, step 5). "Full,
  -- instant, no fee" is a statement about a card that was never touched.
  if v_hold.id is not null then
    select * into v_frozen from public.job_financials f where f.job_id = p_job_id;

    if not found then
      return query select 'not_priced'::text, v_tier, v_elapsed,
                          null::bigint, null::bigint, null::bigint, null::uuid,
                          'This job has escrow but no frozen price. Nothing has been changed.'::text;
      return;
    end if;

    if v_hold.amount_paise <> v_frozen.budget_paise then
      return query select 'not_priced'::text, v_tier, v_elapsed,
                          null::bigint, null::bigint, null::bigint, null::uuid,
                          format('Escrow holds %s paise but the job was priced at %s.',
                                 v_hold.amount_paise, v_frozen.budget_paise)::text;
      return;
    end if;

    -- The worker's share of the budget, in basis points. 20% in the middle tier
    -- and nothing anywhere else.
    v_share_bps := case v_tier
                     when 'mid'::public.cancellation_tier then v_mid_worker
                     else 0
                   end;

    -- Floored, so the remainder falls to the client rather than to the worker.
    v_worker_sum := (v_frozen.budget_paise * v_share_bps) / 10000;

    -- Spec §8: "never charged when no worker opted in — that is Zevi's failure,
    -- not the client's." The pre-assignment tier is exactly that case and is the
    -- only row of the table the spec gives no fee to. Capped at what is left
    -- after the worker's share, so a refund can never come out negative.
    v_fee := case
               when v_tier = 'pre_assignment'::public.cancellation_tier then 0
               else least(
                 public.fee_amount_paise('cancellation', v_frozen.budget_paise),
                 greatest(v_frozen.budget_paise - v_worker_sum, 0)
               )
             end;

    v_refund := v_frozen.budget_paise - v_worker_sum - v_fee;

    -- Pro-rated by the same share as the money, exactly as `resolve_dispute()`
    -- pro-rates a split: a worker paid 20% of the budget is charged commission
    -- on 20% of it. Both floored, so the remainder lands with the worker and the
    -- net can never go negative.
    v_worker_comm := (v_frozen.worker_commission_paise * v_share_bps) / 10000;
    v_worker_tax  := (v_frozen.worker_tax_paise * v_share_bps) / 10000;
    v_worker_net  := v_worker_sum - v_worker_comm - v_worker_tax;

    if v_worker_net < 0 or v_refund < 0 then
      raise exception 'cancelling job % computed a negative share (worker %, client %)',
        p_job_id, v_worker_net, v_refund using errcode = 'check_violation';
    end if;
  end if;

  -- ---- the record of the decision ------------------------------------------

  insert into public.cancellations (
    job_id, cancelled_by, actor_role, tier, elapsed_bps, reason,
    client_refund_paise, worker_compensation_paise, fee_paise, admin_assessed
  )
  values (
    p_job_id, p_client_id, 'client'::public.party_role, v_tier, v_elapsed, v_reason,
    v_refund, v_worker_sum, v_fee, false
  )
  returning * into v_cancel;

  -- ---- escrow and the ledger -----------------------------------------------

  if v_hold.id is not null then
    update public.escrow_holds h
       set status         = case when v_worker_sum > 0
                                 then 'split'::public.escrow_status
                                 else 'refunded'::public.escrow_status end,
           released_at    = case when v_worker_sum > 0 then now() else h.released_at end,
           released_paise = v_worker_sum,
           refunded_paise = v_refund
     where h.id = v_hold.id;

    -- Only what actually leaves escrow. The client's refund is still in the
    -- platform's gateway account waiting on a call that does not exist, and the
    -- honest ledger for money that has not moved is no entry at all.
    if v_worker_sum + v_fee > 0 then
      insert into public.ledger_transactions (
        kind, job_id, reference_type, reference_id, description, idempotency_key, created_by
      )
      values (
        'escrow_released'::public.ledger_txn_kind, p_job_id, 'cancellation', v_cancel.id,
        'Escrow divided on a ' || v_tier || ' cancellation',
        -- Keyed by job, as 0030 and 0034 key it: a job's escrow is released
        -- once, whether by acceptance, by a decision, or by this.
        'escrow_released:' || p_job_id::text,
        p_client_id
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
        values (v_txn_id, v_acct_escrow, 'credit'::public.ledger_direction,
                v_worker_sum + v_fee, p_job_id);

        if v_worker_net > 0 then
          if v_worker_id is null then
            raise exception 'job % owes a worker share with nobody assigned', p_job_id
              using errcode = 'no_data_found';
          end if;

          v_worker_acct := public.ensure_worker_ledger_account(v_worker_id);

          if v_worker_acct is null then
            raise exception 'worker % has no payable account', v_worker_id
              using errcode = 'no_data_found';
          end if;

          insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
          values (v_txn_id, v_worker_acct, 'debit'::public.ledger_direction, v_worker_net, p_job_id);
        end if;

        -- The worker's commission and the cancellation fee are both revenue,
        -- earned at this moment for different reasons, and they are one leg
        -- because a ledger records amounts rather than justifications. The
        -- `cancellations` row is where the ₹15 stays separately readable.
        if v_worker_comm + v_fee > 0 then
          insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
          values (v_txn_id, v_acct_revenue, 'debit'::public.ledger_direction,
                  v_worker_comm + v_fee, p_job_id);
        end if;

        if v_worker_tax > 0 then
          insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
          values (v_txn_id, v_acct_tax, 'debit'::public.ledger_direction, v_worker_tax, p_job_id);
        end if;
      end if;
    end if;

    -- ---- the worker's earning ---------------------------------------------
    --
    -- Stamped the way acceptance and a dispute release stamp it: eligible 48
    -- hours on, held 14 days if the client is new. A worker compensated for a
    -- cancellation is paid on the same calendar as one who was accepted.

    if v_worker_sum > 0 and v_worker_id is not null then
      insert into public.worker_earnings (
        job_id, worker_id, status, gross_paise, commission_paise, tax_paise, net_paise,
        accepted_at, eligible_at, hold_until, hold_reason
      )
      select
        p_job_id,
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
      on conflict on constraint worker_earnings_job_id_key do nothing;
    end if;

    -- ---- the refund the gateway has not made yet ---------------------------

    if v_refund > 0 then
      select p.id into v_payment_id
      from public.payments p
      where p.job_id = p_job_id
        and p.status = 'captured'::public.payment_status
      order by p.captured_at desc nulls last
      limit 1;

      if v_payment_id is null then
        raise exception 'job % has escrow but no captured payment to refund against', p_job_id
          using errcode = 'no_data_found';
      end if;

      insert into public.refunds (
        job_id, payment_id, cancellation_id, amount_paise, reason, note, status, initiated_by
      )
      values (
        p_job_id, v_payment_id, v_cancel.id, v_refund,
        'client_cancellation'::public.refund_reason, v_reason,
        -- Spec §14 puts it back on the original method in 5–7 working days.
        -- Razorpay's refund API is not wired, so this is a queued instruction
        -- and says so by staying `pending`.
        'pending'::public.refund_status, p_client_id
      );
    end if;
  end if;

  -- ---- the job, the assignment and the opt-ins ------------------------------

  update public.jobs j
     set status       = 'cancelled'::public.job_status,
         cancelled_at = now()
   where j.id = p_job_id;

  if v_claim.id is not null then
    update public.job_assignments a
       set status       = 'cancelled'::public.assignment_status,
           ended_at     = now(),
           ended_reason = 'cancelled by the client (' || v_tier || ')'
     where a.id = v_claim.id;
  end if;

  -- Everyone still waiting to hear. `sync_opt_in_counters()` recounts from these
  -- rows, so freeing the slots is what this update is really for — a worker
  -- should not be holding one of their five for a job that no longer exists.
  update public.job_opt_ins o
     set status = 'expired'::public.opt_in_status
   where o.job_id = p_job_id
     and o.status in ('active'::public.opt_in_status, 'shortlisted'::public.opt_in_status);

  -- ---- the counters --------------------------------------------------------
  --
  -- Spec §5 puts the cancellation rate on the public client profile, so it has
  -- to move here or it never moves at all.

  update public.client_profiles c
     set jobs_cancelled        = c.jobs_cancelled + 1,
         cancellation_rate_bps = least(
           10000,
           ((c.jobs_cancelled + 1) * 10000) / greatest(c.jobs_posted, 1)
         )
   where c.profile_id = v_job.client_id;

  -- ---- files ---------------------------------------------------------------
  --
  -- Spec §12 gives a cancelled job 7 days. Nothing was delivered on any tier
  -- that reaches here, so this is the brief's own attachments. The sweeper that
  -- reads `delete_after` is still not built, so this only sets the clock.

  update public.files f
     set delete_after     = now() + make_interval(days => public.setting_int('files.retention_days_accepted', 7)),
         retention_reason = 'cancelled job'
   where f.purged_at is null
     and f.id in (
       select a.file_id from public.job_attachments a where a.job_id = p_job_id
     );

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id, p_client_id, 'client'::public.party_role, 'job.cancelled',
    jsonb_build_object(
      'cancellation_id', v_cancel.id,
      'tier',            v_tier,
      'elapsed_bps',     v_elapsed,
      'client_paise',    v_refund,
      'worker_paise',    v_worker_sum,
      'fee_paise',       v_fee
    )
  );

  return query select 'cancelled'::text, v_tier, v_elapsed, v_refund, v_worker_sum, v_fee,
                      null::uuid, null::text;
end;
$$;

comment on function public.request_job_cancellation is
  'Spec §5''s cancellation tiers, applied in one transaction: escrow divided, '
  'the worker''s share and the fee through the ledger, the client''s refund '
  'queued pending a gateway call that is not wired. A late request opens a '
  'capped dispute instead. service_role only (0036).';

-- ============================================================================
-- resolve_dispute — replaced, to honour the cancellation cap
--
-- 0034's function, unchanged in every respect but three:
--
--   1. `client_refund_cap_bps` is enforced. A case opened by a >50% cancellation
--      carries spec §5's 70% ceiling, and a `refund` (which is 100% to the
--      client) or a `split` above the cap is refused by name rather than quietly
--      clamped — a reviewer who typed 90 needs to know the rule exists, not to
--      discover later that the client got 70.
--   2. A capped case writes its `cancellations` row on decision, `admin_assessed`
--      with the deciding admin on it. That is the fourth row of spec §5's table
--      finally being recorded as a cancellation rather than only as a dispute.
--   3. `disputes_lost` moves. Spec §11 calls dispute rate "the most useful
--      signal you'll have in year one", and a counter nothing increments is not
--      a signal.
--
-- Everything else — the lock order, the escrow bound, the four ledger legs, the
-- pro-rated split, the earning, the pending refund, the counters and the audit
-- row — is 0034's, reproduced because plpgsql has no way to patch a body.
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
  v_client_bps  integer;
  v_loser       uuid;

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

  -- ---- spec §5's 70% ceiling, where a late cancellation left it ------------
  --
  -- The client's share of each outcome: all of it on a refund, none on a
  -- release, the typed share on a split. Compared against the cap before any
  -- arithmetic, so a refused decision changes nothing at all.

  v_client_bps := case v_outcome
                    when 'refund'::public.dispute_outcome  then 10000
                    when 'release'::public.dispute_outcome then 0
                    else p_split_client_bps
                  end;

  if v_case.client_refund_cap_bps is not null
     and v_client_bps > v_case.client_refund_cap_bps then
    return query select 'over_cap'::text, null::public.dispute_outcome,
                        null::bigint, null::bigint,
                        format('This case came from a cancellation more than half way through '
                               'the deadline, so spec §5 caps the client at %s%% of the budget. '
                               'A %s would give them %s%%.',
                               v_case.client_refund_cap_bps / 100, p_outcome,
                               v_client_bps / 100)::text;
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
  -- On a release `v_worker_bps` is 10000 and every figure below collapses to the
  -- frozen one, which is the property that matters: a full release writes the
  -- same four ledger legs, for the same amounts, as `accept_job_delivery()`.

  v_worker_bps  := 10000 - v_client_bps;

  v_worker_sum  := (v_frozen.budget_paise * v_worker_bps) / 10000;
  v_client_sum  := v_frozen.budget_paise - v_worker_sum;
  v_worker_comm := (v_frozen.worker_commission_paise * v_worker_bps) / 10000;
  v_worker_tax  := (v_frozen.worker_tax_paise * v_worker_bps) / 10000;
  v_worker_net  := v_worker_sum - v_worker_comm - v_worker_tax;

  if v_worker_net < 0 then
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

  if v_worker_sum > 0 then
    if v_worker_id is null then
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
      'pending'::public.refund_status,
      p_admin_id
    );
  end if;

  -- ---- the cancellation this case actually was -----------------------------
  --
  -- Spec §5's fourth row, recorded as what it is. Only for a capped case: an
  -- ordinary dispute is not a cancellation and must not land in the cancellation
  -- rate on anyone's public profile.

  if v_case.client_refund_cap_bps is not null then
    insert into public.cancellations (
      job_id, cancelled_by, actor_role, tier, reason,
      client_refund_paise, worker_compensation_paise, fee_paise,
      admin_assessed, assessed_by
    )
    values (
      v_job_id, v_job.client_id, 'admin'::public.party_role,
      'late'::public.cancellation_tier, v_note,
      v_client_sum, v_worker_sum, 0, true, p_admin_id
    )
    on conflict on constraint cancellations_job_id_key do nothing;
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

  -- ---- spec §11's dispute rate --------------------------------------------
  --
  -- Which way it went. A split marks nobody: the outcome that says both sides
  -- had a point is exactly the one that should not go on a record read as "times
  -- this person was wrong".

  v_loser := case v_outcome
               when 'release'::public.dispute_outcome then v_job.client_id
               when 'refund'::public.dispute_outcome  then v_worker_id
             end;

  if v_loser is not null then
    insert into public.user_private_stats as s (profile_id, disputes_lost)
    values (v_loser, 1)
    on conflict on constraint user_private_stats_pkey
    do update set disputes_lost = s.disputes_lost + 1;
  end if;

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
  -- the 7 days an accepted one gets.
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
      'split_client_bps', p_split_client_bps,
      'cap_bps',          v_case.client_refund_cap_bps
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
  'not wired. Refuses a job whose escrow is already settled, and refuses to '
  'exceed the ceiling a late cancellation carries (0034, replaced by 0036).';

-- ============================================================================
-- The direct-write paths, closed
--
-- 0015 wrote two INSERT policies on the assumption that raising a dispute and
-- answering one were ordinary user writes. They are not, and it is the reason
-- 0030 gave when it dropped the delivery policies: each of these moves a row the
-- same statement cannot finish. Raising a dispute freezes escrow, stops the
-- auto-accept clock and moves the job; answering one moves the case into review.
-- `disputes` already had UPDATE revoked, so a browser could write the first half
-- of either and none of the rest.
--
-- The offer policies on `dispute_offers` are left exactly as they are. Layer 2
-- has no code at all, so there is nothing for them to be inconsistent with yet,
-- and the day self-settlement is built is the day to decide whether it is a
-- function too.
-- ============================================================================

drop policy if exists "participants raise a dispute" on public.disputes;
drop policy if exists "parties write their own statement" on public.dispute_statements;

revoke insert on public.disputes from anon, authenticated;
revoke insert on public.dispute_statements from anon, authenticated;

-- Both sides already read what they need: `both sides read the dispute` and
-- `both sides read statements` (0015) cover the case, and `participants read
-- cancellations` / `participants read refunds` (0012) cover the money, all four
-- through `is_job_participant` or `is_dispute_party`. Checked rather than
-- assumed — 0035 exists because a console screen could not read something and
-- nobody had looked.

-- ============================================================================
-- Grants
--
-- All four decide where money goes or freeze it in place. None is callable from
-- a browser: the Server Actions in `lib/cancellations/` and `lib/disputes/` hold
-- the service-role key and re-derive the actor from the session first, which is
-- what each function's own actor check is checking again.
-- ============================================================================

revoke execute on function public.request_job_cancellation(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_job_cancellation(uuid, uuid, text) to service_role;

revoke execute on function public.open_dispute(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.open_dispute(uuid, uuid, text, text, integer) to service_role;

revoke execute on function public.respond_to_dispute(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.respond_to_dispute(uuid, uuid, text) to service_role;

revoke execute on function public.resolve_dispute(uuid, uuid, text, text, integer, inet)
  from public, anon, authenticated;
grant execute on function public.resolve_dispute(uuid, uuid, text, text, integer, inet)
  to service_role;
