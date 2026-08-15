-- ============================================================================
-- Zevi 0030 — delivery, acceptance, the free revision, and the auto-accept clock
--
-- Spec §4 steps 7–9, and the second half of the money 0029 started. 0029 put the
-- client's payment into escrow and recognised the *client's* commission, because
-- that is earned at capture. This migration is the other moment: acceptance
-- releases escrow, recognises the *worker's* commission, and turns the budget
-- into a `worker_earnings` row. Spec §8's "Zevi gross" is complete only after
-- both have run.
--
-- Four functions, all service_role only, and the split between them is the same
-- design 0029 used:
--
--   submit_job_delivery()   the worker sends work. Attempt numbering, the
--                           supersede of the previous attempt and the job's own
--                           status all move together, so none of it is a
--                           browser INSERT.
--   accept_job_delivery()   ONE transaction: the delivery, escrow, the ledger,
--                           the earning, the assignment, the counters and the
--                           unlock of the clean files. An escrow hold released
--                           without a worker earning is money nobody can
--                           account for; an earning without the release is a
--                           balance sheet that does not add up. Neither is
--                           representable.
--   request_job_revision()  the one free revision (spec §5).
--   sweep_auto_accepts()    the clock: 36 hours under ₹1,000, 3 days at or
--                           above it. Auto-acceptance is the same function as a
--                           click, with p_auto set, so there is exactly one
--                           implementation of "this job is done".
--
-- ---------------------------------------------------------------------------
-- Where the money goes, in ledger terms
--
-- At capture (0029) escrow took the whole budget. Release splits it three ways:
--
--   escrow           -= budget                 the hold is emptied
--   worker_payable   += worker net             the worker's, pending a payout
--   platform_revenue += worker commission      earned now — the worker's half
--   tax_payable      += worker GST             collected, owed onward
--
-- Those three sum to the budget by the identity `open_job_payment()` already
-- checked (`worker_net = budget - worker_commission - worker_tax`), which is why
-- this function takes no amounts either. Every figure is read from
-- `job_financials`, frozen before a card was ever charged.
--
-- ---------------------------------------------------------------------------
-- What this migration deliberately does NOT do
--
--   * Reminders. `reminder_1_sent_at` / `reminder_2_sent_at` stay null: spec §5
--     wants nudges at 12h/30h and 24h/60h, and there is no email provider wired
--     up. Stamping "sent" for a message nobody sent would be a lie in the one
--     table a chargeback is argued from.
--   * The second revision. Spec §5 gives it "only by worker agreement,
--     otherwise dispute", and neither the agreement flow nor disputes exist —
--     so `request_job_revision()` refuses past the free one rather than
--     writing a row nothing can move. `job_revisions.due_at` stays null for the
--     same reason: the spec sets no revision turnaround, and inventing one
--     would invent a lateness penalty with it.
--   * Payouts. The earning lands as `confirmed` (or `on_hold` for a new
--     client's first three jobs, spec §6) and stops there. Money still cannot
--     leave the platform account — see the note in CLAUDE.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The clock reads its own settings
--
-- 0008 hardcoded 36 hours and 3 days into `auto_accept_deadline()`, while 0018
-- seeded `delivery.auto_accept_hours_under_1000` and
-- `delivery.auto_accept_days_from_1000` for someone to read. Nobody did. The
-- stamp is the place to fix that: `auto_accept_deadline()` stays immutable with
-- the spec's numbers as its shape, and the trigger — which runs once, at
-- delivery, and stores the answer — is what consults the settings.
--
-- Computed once and stored, exactly as 0008 said: a client promised 36 hours
-- gets 36 hours even if the setting moves an hour later.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public)
values (
  'delivery.auto_accept_threshold_paise', '100000', 'int',
  'Budget at which the auto-accept window changes from hours to days (spec §5).', true
)
on conflict (key) do nothing;

create or replace function public.stamp_auto_accept_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  budget      bigint;
  v_from      timestamptz;
  v_threshold bigint;
  v_hours     integer;
  v_days      integer;
begin
  select j.budget_paise into budget from public.jobs j where j.id = new.job_id;

  v_from      := coalesce(new.delivered_at, now());
  v_threshold := public.setting_bigint('delivery.auto_accept_threshold_paise', 100000);
  v_hours     := public.setting_int('delivery.auto_accept_hours_under_1000', 36);
  v_days      := public.setting_int('delivery.auto_accept_days_from_1000', 3);

  -- A null budget cannot reach here (`jobs_publishable` forbids it past draft),
  -- but if it ever did, the longer window is the safe way to be wrong.
  new.auto_accept_at := case
    when budget is not null and budget < v_threshold
      then v_from + make_interval(hours => v_hours)
    else v_from + make_interval(days => v_days)
  end;

  return new;
end;
$$;

comment on function public.stamp_auto_accept_deadline is
  'Trigger: stores the auto-accept deadline at delivery, from platform_settings '
  '(0030). Computed once so a rule change never shortens a promise already made.';

-- ============================================================================
-- submit_job_delivery — the worker sends work
--
-- 0008 gave the assigned worker an INSERT policy on `job_deliveries` and
-- `delivery_files`. That was never enough on its own: a delivery has to pick its
-- own attempt number against a unique constraint, supersede whatever attempt is
-- still standing, close the revision it answers and move the job — and
-- `job_deliveries` has UPDATE revoked, so a browser could do the first part and
-- none of the rest. Those two policies are dropped at the bottom of this file
-- and this is the only way in, the same way `claim_job_assignment()` is the only
-- way into `job_assignments`.
-- ============================================================================

create or replace function public.submit_job_delivery(
  p_job_id    uuid,
  p_worker_id uuid,
  p_note      text,
  p_file_ids  uuid[]
)
returns public.job_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  target     public.jobs;
  claim      public.job_assignments;
  fresh      public.job_deliveries;
  v_attempt  integer;
  v_file_id  uuid;
  v_position integer := 0;
  v_count    integer;
begin
  -- Jobs first, always — the same lock order 0029's three functions take, so a
  -- delivery landing while a webhook settles cannot deadlock against it.
  select * into target from public.jobs where id = p_job_id for update;

  if not found then
    raise exception 'job % does not exist', p_job_id using errcode = 'no_data_found';
  end if;

  select * into claim
  from public.job_assignments
  where job_id = p_job_id and status = 'active'::public.assignment_status;

  if not found then
    raise exception 'job % has no active assignment', p_job_id
      using errcode = 'no_data_found';
  end if;

  if claim.worker_id <> p_worker_id then
    raise exception 'only the assigned worker may deliver this job'
      using errcode = 'insufficient_privilege';
  end if;

  -- 'delivered' is not in the list on purpose: a second delivery with no
  -- revision between them would leave two attempts awaiting review and two
  -- auto-accept clocks running.
  if target.status not in ('assigned'::public.job_status, 'revision_requested'::public.job_status) then
    raise exception 'job % is % and is not waiting on a delivery', p_job_id, target.status
      using errcode = 'check_violation';
  end if;

  v_count := coalesce(array_length(p_file_ids, 1), 0);

  if v_count = 0 then
    raise exception 'a delivery needs at least one file' using errcode = 'check_violation';
  end if;

  select coalesce(max(d.attempt), 0) + 1 into v_attempt
  from public.job_deliveries d
  where d.job_id = p_job_id;

  -- Whatever was standing is now history. Both statuses are reachable: the
  -- first if the client never responded, the second if they asked for this.
  update public.job_deliveries
     set status = 'superseded'::public.delivery_status
   where job_id = p_job_id
     and status in ('pending_review'::public.delivery_status,
                    'revision_requested'::public.delivery_status);

  update public.job_revisions
     set status = 'delivered'::public.revision_status
   where job_id = p_job_id
     and status in ('requested'::public.revision_status,
                    'accepted_by_worker'::public.revision_status);

  -- `auto_accept_at` is left out: it is NOT NULL, and the BEFORE INSERT trigger
  -- fills it from the job's budget before the constraint is checked. Passing one
  -- here would be a caller deciding how long the client gets.
  insert into public.job_deliveries (job_id, assignment_id, worker_id, attempt, note)
  values (p_job_id, claim.id, p_worker_id, v_attempt, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into fresh;

  foreach v_file_id in array p_file_ids loop
    -- Registered by this worker, as a delivery, and still there. A file id from
    -- somewhere else — a sample, a client's own attachment — stops here.
    if not exists (
      select 1 from public.files f
      where f.id = v_file_id
        and f.owner_id = p_worker_id
        and f.purpose = 'delivery'::public.file_purpose
        and f.purged_at is null
    ) then
      raise exception 'file % is not one of this worker''s delivery files', v_file_id
        using errcode = 'check_violation';
    end if;

    -- Re-sending an unchanged asset on attempt 2 is normal and allowed. Sending
    -- the same object on a *different* job is how one delivery gets billed
    -- twice.
    if exists (
      select 1
      from public.delivery_files df
      join public.job_deliveries d on d.id = df.delivery_id
      where df.file_id = v_file_id and d.job_id <> p_job_id
    ) then
      raise exception 'file % has already been delivered on another job', v_file_id
        using errcode = 'unique_violation';
    end if;

    -- unlocked_at stays null. That column is the whole access model: until
    -- acceptance writes it, the client gets a watermarked preview or nothing.
    insert into public.delivery_files (delivery_id, file_id, position)
    values (fresh.id, v_file_id, v_position)
    on conflict (delivery_id, file_id) do nothing;

    v_position := v_position + 1;
  end loop;

  update public.jobs
     set status       = 'delivered'::public.job_status,
         delivered_at = now()
   where id = p_job_id;

  update public.worker_profiles
     set last_delivered_at = now()
   where profile_id = p_worker_id;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id, p_worker_id, 'worker'::public.party_role, 'delivery.submitted',
    jsonb_build_object(
      'delivery_id',    fresh.id,
      'attempt',        v_attempt,
      'file_count',     v_count,
      'auto_accept_at', fresh.auto_accept_at
    )
  );

  return fresh;
end;
$$;

-- ============================================================================
-- accept_job_delivery — one transaction, or none of it
--
-- The client's click and the auto-accept sweep are the same call; `p_auto` is
-- the only difference, and it decides two things — who may do it (the client, or
-- the clock) and what the record says afterwards.
--
-- Safe to call twice, because it will be: a client clicking Accept at the moment
-- the sweep reaches their job is not a rare race, it is the *likely* one. The
-- first caller takes the job row lock; the second finds the delivery already
-- accepted and returns it.
-- ============================================================================

create or replace function public.accept_job_delivery(
  p_delivery_id uuid,
  p_actor_id    uuid default null,
  p_auto        boolean default false
)
returns public.job_deliveries
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.jobs;
  entry  public.job_deliveries;
  frozen public.job_financials;
  hold   public.escrow_holds;

  v_job_id         uuid;
  v_actor          uuid;
  v_txn_id         uuid;
  v_worker_account uuid;
  v_client_jobs    integer;
  v_hold_threshold integer;
  v_hold_days      integer;
  v_eligible_hours integer;
  v_retention_days integer;
  v_on_time        boolean;

  acct_escrow  uuid;
  acct_revenue uuid;
  acct_tax     uuid;
begin
  select job_id into v_job_id from public.job_deliveries where id = p_delivery_id;

  if v_job_id is null then
    raise exception 'delivery % does not exist', p_delivery_id using errcode = 'no_data_found';
  end if;

  select * into target from public.jobs where id = v_job_id for update;
  select * into entry from public.job_deliveries where id = p_delivery_id for update;

  -- The sweep and the button, arriving together. Whoever was second gets the
  -- accepted row rather than an error the other party caused.
  if entry.status = 'accepted'::public.delivery_status then
    return entry;
  end if;

  if entry.status <> 'pending_review'::public.delivery_status then
    raise exception 'delivery % is % and cannot be accepted', p_delivery_id, entry.status
      using errcode = 'check_violation';
  end if;

  if p_auto then
    -- The clock is the authority for an automatic acceptance, and it has to have
    -- actually run out. A sweep that accepts early is a client robbed of the
    -- window they were promised.
    if now() < entry.auto_accept_at then
      raise exception 'delivery % does not auto-accept until %', p_delivery_id, entry.auto_accept_at
        using errcode = 'check_violation';
    end if;
    v_actor := null;
  else
    if p_actor_id is null or p_actor_id <> target.client_id then
      raise exception 'only the client of this job may accept its delivery'
        using errcode = 'insufficient_privilege';
    end if;
    v_actor := p_actor_id;
  end if;

  -- ---- what the job was priced at, and what is actually held ---------------

  select * into frozen from public.job_financials where job_id = v_job_id;

  if not found then
    raise exception 'job % has no frozen price; nothing was ever paid for it', v_job_id
      using errcode = 'no_data_found';
  end if;

  select * into hold
  from public.escrow_holds
  where job_id = v_job_id
    and status in ('held'::public.escrow_status, 'frozen'::public.escrow_status)
  for update;

  if not found then
    raise exception 'job % has nothing in escrow to release', v_job_id
      using errcode = 'no_data_found';
  end if;

  -- A dispute or a chargeback investigation freezes the hold. Accepting past it
  -- would pay a worker out of money that is being argued over.
  if hold.status = 'frozen'::public.escrow_status then
    raise exception 'escrow on job % is frozen and cannot be released', v_job_id
      using errcode = 'check_violation';
  end if;

  -- The ledger legs below assume these are the same number. Saying so here
  -- turns a deferred balance failure at COMMIT into a sentence naming the job.
  if hold.amount_paise <> frozen.budget_paise then
    raise exception 'escrow on job % holds % but the job was priced at %',
      v_job_id, hold.amount_paise, frozen.budget_paise using errcode = 'check_violation';
  end if;

  -- ---- the delivery -------------------------------------------------------

  update public.job_deliveries
     set status        = 'accepted'::public.delivery_status,
         accepted_at   = now(),
         accepted_by   = v_actor,
         auto_accepted = p_auto
   where id = p_delivery_id
  returning * into entry;

  -- ---- escrow -------------------------------------------------------------

  update public.escrow_holds
     set status         = 'released'::public.escrow_status,
         released_at    = now(),
         released_paise = hold.amount_paise
   where id = hold.id;

  -- ---- the ledger ---------------------------------------------------------

  v_worker_account := public.ensure_worker_ledger_account(entry.worker_id);

  if v_worker_account is null then
    raise exception 'worker % has no payable account', entry.worker_id
      using errcode = 'no_data_found';
  end if;

  insert into public.ledger_transactions (
    kind, job_id, reference_type, reference_id, description, idempotency_key, created_by
  )
  values (
    'escrow_released'::public.ledger_txn_kind, v_job_id, 'delivery', p_delivery_id,
    case when p_auto then 'Escrow released on auto-acceptance'
         else 'Escrow released on client acceptance' end,
    -- Keyed by job, not by delivery: a job's escrow is released exactly once,
    -- whichever attempt was the one accepted.
    'escrow_released:' || v_job_id::text,
    v_actor
  )
  on conflict (idempotency_key) do nothing
  returning id into v_txn_id;

  -- Null means the entries are already written — a replay, or an earlier
  -- attempt on this job that somehow got here first.
  if v_txn_id is not null then
    select id into acct_escrow  from public.ledger_accounts where code = 'escrow';
    select id into acct_revenue from public.ledger_accounts where code = 'platform_revenue';
    select id into acct_tax     from public.ledger_accounts where code = 'tax_payable';

    if acct_escrow is null or acct_revenue is null or acct_tax is null then
      raise exception 'the platform ledger accounts are missing. Check migration 0018.'
        using errcode = 'no_data_found';
    end if;

    -- Out of escrow, in full.
    insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
    values (v_txn_id, acct_escrow, 'credit'::public.ledger_direction, hold.amount_paise, v_job_id);

    -- The worker's, pending a payout cycle.
    if frozen.worker_net_paise > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, v_worker_account, 'debit'::public.ledger_direction,
              frozen.worker_net_paise, v_job_id);
    end if;

    -- The worker's half of the commission — earned now, which is the whole
    -- reason spec §8's gross is realised across two moments.
    if frozen.worker_commission_paise > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_revenue, 'debit'::public.ledger_direction,
              frozen.worker_commission_paise, v_job_id);
    end if;

    -- GST on it. Collected, owed onward, never revenue.
    if frozen.worker_tax_paise > 0 then
      insert into public.ledger_entries (transaction_id, account_id, direction, amount_paise, job_id)
      values (v_txn_id, acct_tax, 'debit'::public.ledger_direction,
              frozen.worker_tax_paise, v_job_id);
    end if;
  end if;

  -- ---- the earning --------------------------------------------------------
  --
  -- Spec §6: eligible 48 hours after acceptance, and held 14 days on a new
  -- client's first three jobs — the chargeback window, not a judgement about the
  -- worker. Both stamps are stored rather than re-derived, so a worker told
  -- "Friday" is paid Friday whatever the settings say by then.

  v_eligible_hours := public.setting_int('payout.eligibility_hours', 48);
  v_hold_threshold := public.setting_int('payout.new_client_job_threshold', 3);
  v_hold_days      := public.setting_int('payout.new_client_hold_days', 14);

  select coalesce(c.jobs_completed, 0) into v_client_jobs
  from public.client_profiles c
  where c.profile_id = target.client_id;

  v_client_jobs := coalesce(v_client_jobs, 0);

  insert into public.worker_earnings (
    job_id, worker_id, status, gross_paise, commission_paise, tax_paise, net_paise,
    accepted_at, eligible_at, hold_until, hold_reason
  )
  values (
    v_job_id,
    entry.worker_id,
    (case when v_client_jobs < v_hold_threshold then 'on_hold' else 'confirmed' end)
      ::public.earning_status,
    frozen.budget_paise,
    frozen.worker_commission_paise,
    frozen.worker_tax_paise,
    frozen.worker_net_paise,
    now(),
    now() + make_interval(hours => v_eligible_hours),
    case when v_client_jobs < v_hold_threshold
         then now() + make_interval(days => v_hold_days) end,
    case when v_client_jobs < v_hold_threshold
         then 'New client — held ' || v_hold_days || ' days against a chargeback' end
  )
  on conflict (job_id) do nothing;

  -- ---- the job, the assignment, and the files -----------------------------

  update public.jobs
     set status        = 'completed'::public.job_status,
         completed_at  = now(),
         auto_accepted = p_auto
   where id = v_job_id;

  update public.job_assignments
     set status       = 'completed'::public.assignment_status,
         ended_at     = now(),
         ended_reason = case when p_auto then 'auto-accepted' else 'accepted by the client' end
   where id = entry.assignment_id;

  -- Every attempt's files, not just the accepted one's: a worker who sent five
  -- files, then re-sent the two they changed, delivered seven. The client paid
  -- for the job, not for the last upload.
  update public.delivery_files df
     set unlocked_at = now()
    from public.job_deliveries d
   where d.id = df.delivery_id
     and d.job_id = v_job_id
     and df.unlocked_at is null;

  -- Spec §12: the object goes 7 days after acceptance, the evidence stays
  -- forever. This sets the clock; the sweeper that reads `delete_after` is not
  -- built yet, so nothing is removed on time — which is the safe way round.
  v_retention_days := public.setting_int('files.retention_days_accepted', 7);

  update public.files f
     set delete_after      = now() + make_interval(days => v_retention_days),
         retention_reason  = 'accepted delivery'
   where f.purged_at is null
     and f.id in (
       select df.file_id
       from public.delivery_files df
       join public.job_deliveries d on d.id = df.delivery_id
       where d.job_id = v_job_id
     );

  -- ---- the counters -------------------------------------------------------
  --
  -- Completion is the only moment these are knowable, and nothing else writes
  -- them. `worker_category_stats` is what the shortlist sorts on (spec §6 keeps
  -- ratings and experience per category), so a completion that skipped it would
  -- leave every worker on the platform reading "0 jobs" forever.

  update public.client_profiles
     set jobs_completed    = jobs_completed + 1,
         last_job_at       = now(),
         total_spend_paise = total_spend_paise + frozen.client_total_paise
   where profile_id = target.client_id;

  update public.worker_profiles
     set jobs_completed = jobs_completed + 1
   where profile_id = entry.worker_id;

  -- Measured at delivery, not at acceptance: the worker controls when they send
  -- it and not when the client reads it.
  v_on_time := target.deadline_at is null or entry.delivered_at <= target.deadline_at;

  if target.category_id is not null then
    insert into public.worker_category_stats as s (
      worker_id, category_id, jobs_completed, on_time_deliveries, late_deliveries,
      last_job_at, updated_at
    )
    values (
      entry.worker_id, target.category_id, 1,
      case when v_on_time then 1 else 0 end,
      case when v_on_time then 0 else 1 end,
      now(), now()
    )
    on conflict (worker_id, category_id) do update
      set jobs_completed     = s.jobs_completed + 1,
          on_time_deliveries = s.on_time_deliveries + (case when v_on_time then 1 else 0 end),
          late_deliveries    = s.late_deliveries + (case when v_on_time then 0 else 1 end),
          last_job_at        = now(),
          updated_at         = now();
  end if;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    v_job_id,
    v_actor,
    (case when p_auto then 'system' else 'client' end)::public.party_role,
    'delivery.accepted',
    jsonb_build_object(
      'delivery_id',             p_delivery_id,
      'attempt',                 entry.attempt,
      'auto',                    p_auto,
      'released_paise',          hold.amount_paise,
      'worker_net_paise',        frozen.worker_net_paise,
      'worker_commission_paise', frozen.worker_commission_paise,
      'worker_tax_paise',        frozen.worker_tax_paise,
      'on_time',                 v_on_time
    )
  );

  return entry;
end;
$$;

-- ============================================================================
-- request_job_revision — the one free revision (spec §5)
--
-- Refuses past the free one rather than opening a second. "A second only by
-- worker agreement, otherwise dispute" needs the worker's answer
-- (`revision_status` has both branches) and a dispute flow for when it is no,
-- and neither exists. The policy that lets a worker answer a request is left in
-- place as the seam for it.
-- ============================================================================

create or replace function public.request_job_revision(
  p_delivery_id uuid,
  p_actor_id    uuid,
  p_reason      text
)
returns public.job_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  target   public.jobs;
  entry    public.job_deliveries;
  ask      public.job_revisions;
  v_job_id uuid;
  v_used   integer;
  v_free   integer;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select job_id into v_job_id from public.job_deliveries where id = p_delivery_id;

  if v_job_id is null then
    raise exception 'delivery % does not exist', p_delivery_id using errcode = 'no_data_found';
  end if;

  select * into target from public.jobs where id = v_job_id for update;
  select * into entry from public.job_deliveries where id = p_delivery_id for update;

  if p_actor_id is null or p_actor_id <> target.client_id then
    raise exception 'only the client of this job may ask for a revision'
      using errcode = 'insufficient_privilege';
  end if;

  if entry.status <> 'pending_review'::public.delivery_status then
    raise exception 'delivery % is % and is not open for a revision', p_delivery_id, entry.status
      using errcode = 'check_violation';
  end if;

  -- The auto-accept window binds both sides. If the sweep has not caught up
  -- yet, this delivery is still accepted-in-all-but-name and asking for changes
  -- past the deadline would take back a promise the worker already earned.
  if now() >= entry.auto_accept_at then
    raise exception 'the review window on delivery % closed at %',
      p_delivery_id, entry.auto_accept_at using errcode = 'check_violation';
  end if;

  -- Mirrors the CHECK on the column, so the client reads a sentence instead of
  -- a constraint name.
  if char_length(v_reason) < 10 then
    raise exception 'a revision request needs at least 10 characters of reason'
      using errcode = 'check_violation';
  end if;

  v_reason := left(v_reason, 1000);

  v_free := public.setting_int('delivery.free_revisions', 1);

  select count(*) into v_used from public.job_revisions where job_id = v_job_id;

  if v_used >= v_free then
    raise exception 'job % has already used its free revision', v_job_id
      using errcode = 'check_violation';
  end if;

  insert into public.job_revisions (
    job_id, delivery_id, requested_by, sequence, is_free, reason, status
  )
  values (
    v_job_id, p_delivery_id, p_actor_id, v_used + 1, v_used = 0, v_reason,
    'requested'::public.revision_status
  )
  returning * into ask;

  update public.job_deliveries
     set status                = 'revision_requested'::public.delivery_status,
         revision_requested_at = now()
   where id = p_delivery_id;

  -- The auto-accept clock stops here: `job_deliveries_auto_accept_idx` is
  -- partial on `status = 'pending_review'`, so the sweep stops seeing this row
  -- the moment the status moves. The next attempt starts a fresh window.
  update public.jobs
     set status         = 'revision_requested'::public.job_status,
         revision_count = revision_count + 1
   where id = v_job_id;

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    v_job_id, p_actor_id, 'client'::public.party_role, 'delivery.revision_requested',
    jsonb_build_object(
      'delivery_id', p_delivery_id,
      'revision_id', ask.id,
      'sequence',    ask.sequence,
      'is_free',     ask.is_free
    )
  );

  return ask;
end;
$$;

-- ============================================================================
-- sweep_auto_accepts — the clock, actually ticking
--
-- Spec §5 step 9: "auto-accept fires if the client goes silent". Every row it
-- touches goes through `accept_job_delivery`, so an automatic acceptance and a
-- clicked one are the same transaction with the same ledger entries — there is
-- no second implementation of completion to drift.
--
-- One failing row must not strand the rest, so each is its own subtransaction
-- and its error comes back as data. A caller that logs the failures is what
-- makes a stuck job visible; a sweep that raises on the first one is what makes
-- it invisible.
-- ============================================================================

create or replace function public.sweep_auto_accepts(p_limit integer default 100)
returns table (delivery_id uuid, job_id uuid, accepted boolean, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  due record;
begin
  for due in
    select d.id as delivery_id, d.job_id as job_id
    from public.job_deliveries d
    where d.status = 'pending_review'::public.delivery_status
      and d.auto_accept_at <= now()
    order by d.auto_accept_at
    limit greatest(coalesce(p_limit, 100), 0)
    -- Two sweeps overlapping (a slow run, a manual trigger) skip each other's
    -- rows rather than queueing behind them.
    for update of d skip locked
  loop
    begin
      perform public.accept_job_delivery(due.delivery_id, null, true);

      sweep_auto_accepts.delivery_id := due.delivery_id;
      sweep_auto_accepts.job_id      := due.job_id;
      sweep_auto_accepts.accepted    := true;
      sweep_auto_accepts.detail      := null;
    exception when others then
      sweep_auto_accepts.delivery_id := due.delivery_id;
      sweep_auto_accepts.job_id      := due.job_id;
      sweep_auto_accepts.accepted    := false;
      sweep_auto_accepts.detail      := sqlerrm;
    end;

    return next;
  end loop;
end;
$$;

-- ============================================================================
-- The direct-write paths, closed
--
-- 0008 wrote three INSERT policies on the assumption that delivery was an
-- ordinary user write. It is not: each of the three moves a row the same
-- statement cannot finish (an attempt number, a superseded predecessor, a job
-- status) and acceptance moves money. The functions above are the only way in.
-- ============================================================================

drop policy if exists "the assigned worker delivers" on public.job_deliveries;
drop policy if exists "workers attach their own delivery files" on public.delivery_files;
drop policy if exists "clients request revisions" on public.job_revisions;

revoke insert on public.job_deliveries from anon, authenticated;
revoke insert on public.delivery_files from anon, authenticated;
revoke insert on public.job_revisions from anon, authenticated;

-- ============================================================================
-- Grants
--
-- All four decide, or record, that money moved. None is callable from a browser:
-- the Server Actions that call them hold the service-role key and re-derive the
-- caller from the session first.
-- ============================================================================

revoke execute on function public.submit_job_delivery(uuid, uuid, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.submit_job_delivery(uuid, uuid, text, uuid[]) to service_role;

revoke execute on function public.accept_job_delivery(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.accept_job_delivery(uuid, uuid, boolean) to service_role;

revoke execute on function public.request_job_revision(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_job_revision(uuid, uuid, text) to service_role;

revoke execute on function public.sweep_auto_accepts(integer)
  from public, anon, authenticated;
grant execute on function public.sweep_auto_accepts(integer) to service_role;

-- ============================================================================
-- Storage
--
-- Two prefixes, and the difference between them is the point.
--
--   deliveries/<worker id>/<job id>/<uuid>.<ext>
--       The worker's own upload. They may write, read and — until they have
--       actually sent it — remove it.
--
--   delivery-previews/<worker id>/<job id>/<uuid>.<ext>
--       The watermarked derivative. No policy at all, for anyone: it is written
--       with the service-role key and read through a signed URL minted after the
--       caller has been checked. A worker who could overwrite their own preview
--       could hand a client the clean file before acceptance, which is the one
--       thing this whole model exists to prevent.
--
-- Neither is readable by the client through a policy. Access to a delivery
-- depends on `delivery_files.unlocked_at`, and 0004 already said what that
-- means: a decision, not a row predicate.
-- ============================================================================

drop policy if exists "workers upload their own delivery files" on storage.objects;
drop policy if exists "workers read their own delivery files" on storage.objects;
drop policy if exists "workers remove delivery files they have not sent" on storage.objects;

create policy "workers upload their own delivery files"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'deliveries'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "workers read their own delivery files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'deliveries'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- Removal stops at the moment it is sent. After that the client has seven days
-- to take their copy (spec §12), and a worker who could delete the object could
-- take the work back after being paid for it.
create policy "workers remove delivery files they have not sent"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'deliveries'
    and (storage.foldername(name))[2] = (select auth.uid())::text
    and not exists (
      select 1
      from public.delivery_files df
      join public.files f on f.id = df.file_id
      where f.storage_key = objects.name
    )
  );

comment on function public.submit_job_delivery is
  'The assigned worker sends an attempt: numbers it, supersedes the previous '
  'one, attaches the files locked, and moves the job to delivered (0030).';
comment on function public.accept_job_delivery is
  'Acceptance, clicked or automatic: releases escrow, writes the balanced '
  'escrow_released ledger transaction, opens the worker earning, completes the '
  'job and unlocks the clean files — in one transaction (0030).';
comment on function public.request_job_revision is
  'The one free revision (spec §5). Refuses past it: a second needs the worker '
  'to agree, which is not built (0030).';
comment on function public.sweep_auto_accepts is
  'Accepts every delivery past its auto_accept_at, one subtransaction each, '
  'returning what it did (0030).';
