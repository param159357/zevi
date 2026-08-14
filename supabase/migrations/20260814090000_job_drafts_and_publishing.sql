-- ============================================================================
-- Zevi 0022 — draft jobs and publishing
--
-- Two things the posting flow needs that 0006 did not provide.
--
-- 1. A draft that can hold a half-written brief. 0006 declared title,
--    description and budget NOT NULL with their length checks inline, which
--    makes the first autosave impossible: nothing can be stored until the
--    description passes twenty characters, and the moment work is most likely
--    to be lost is the minute before that. The three columns become nullable
--    here and every rule 0006 stated moves into `jobs_publishable`, which binds
--    on every status except 'draft'. A published job is constrained exactly as
--    it was; only a draft is allowed to be incomplete.
--
-- 2. `publish_job()`. Posting touches four tables — the job, the moderation
--    queue, the classification queue and the client's counters — three of which
--    have INSERT revoked from `authenticated` precisely so a browser cannot
--    decide it skipped review. One function keeps it atomic: a job that reaches
--    'open' without its moderation row is prohibited work sitting in the live
--    feed, and that is the failure this whole path exists to prevent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Drafts may be incomplete
-- ----------------------------------------------------------------------------

alter table public.jobs
  alter column title drop not null,
  alter column description drop not null,
  alter column budget_paise drop not null;

-- The inline checks from 0006 carry names Postgres generated. Matching on the
-- definition rather than the name means this still finds them if they were
-- ever renamed by hand.
do $$
declare
  doomed record;
begin
  for doomed in
    select con.conname
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.jobs'::regclass
      and con.contype = 'c'
      and (pg_catalog.pg_get_constraintdef(con.oid) like '%char_length(title)%'
        or pg_catalog.pg_get_constraintdef(con.oid) like '%char_length(description)%'
        or pg_catalog.pg_get_constraintdef(con.oid) like '%budget_paise >= 14900%')
  loop
    execute format('alter table public.jobs drop constraint %I', doomed.conname);
  end loop;
end;
$$;

alter table public.jobs
  -- Upper bounds still apply to a draft: an incomplete brief is not licence to
  -- store a megabyte of text.
  add constraint jobs_title_length
    check (title is null or char_length(title) <= 120),
  add constraint jobs_description_length
    check (description is null or char_length(description) <= 5000),
  add constraint jobs_budget_not_negative
    check (budget_paise is null or budget_paise >= 0),
  -- Everything 0006 required, re-imposed the moment a job stops being a draft.
  -- The deadline joins them: spec §5 has the client set one, and a job in the
  -- feed without it has no cancellation tier and no auto-accept clock.
  add constraint jobs_publishable check (
    status = 'draft' or (
      title is not null and char_length(title) between 5 and 120
      and description is not null and char_length(description) between 20 and 5000
      and budget_paise is not null and budget_paise >= 14900
      and deadline_at is not null
    )
  );

comment on constraint jobs_publishable on public.jobs is
  'The NOT NULL and length rules from 0006, applied to every status except '
  'draft. Drafts are autosaved from the first keystroke and are allowed to be '
  'incomplete; nothing else is.';

-- ----------------------------------------------------------------------------
-- The deadline cap, with a null budget now possible
--
-- Unchanged from 0006 apart from the budget guard: a draft being repriced can
-- pass through here with no budget at all, and max_deadline_days(null) would
-- silently return the 30-day cap rather than refusing to guess.
-- ----------------------------------------------------------------------------

create or replace function public.enforce_job_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  cap integer;
begin
  -- Deadline cap, applied whenever the job is (re)published or repriced while
  -- still open.
  if new.status in ('open', 'pending_moderation')
     and new.deadline_at is not null
     and new.budget_paise is not null then
    cap := public.max_deadline_days(new.budget_paise);
    if new.deadline_at > coalesce(new.published_at, now()) + make_interval(days => cap) then
      raise exception 'deadline exceeds the % day cap for a job of % paise', cap, new.budget_paise
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.assigned_at is not null then
    -- After assignment the brief and the price are frozen: the worker priced
    -- their opt-in against them.
    if new.description is distinct from old.description
       or new.budget_paise is distinct from old.budget_paise
       or new.category_id is distinct from old.category_id
       or new.title is distinct from old.title then
      raise exception 'title, description, category and budget are locked once a worker is assigned'
        using errcode = 'check_violation';
    end if;

    -- The deadline may move outward only.
    if new.deadline_at is distinct from old.deadline_at
       and new.deadline_at < old.deadline_at then
      raise exception 'the deadline can only be extended after assignment'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- Drafts are the one thing a client accumulates without ever publishing, and
-- the dashboard reads them on every visit.
create index if not exists jobs_client_drafts_idx
  on public.jobs (client_id, updated_at desc) where status = 'draft';

-- ----------------------------------------------------------------------------
-- publish_job
--
-- The only way a job leaves 'draft'. Called with the service-role key from a
-- Server Action that has already established who the caller is; `p_client_id`
-- is checked against the row here as well, because this function is the last
-- thing standing between a form payload and the live feed.
--
-- Returns one row. `status` is one of:
--   published             — see new_status for 'open' vs 'pending_moderation'
--   not_found · forbidden · not_a_draft
--   incomplete            — a required field is still missing
--   budget_out_of_range   — outside the platform_settings window
--   deadline_out_of_range — past, or beyond the cap for this budget
-- ----------------------------------------------------------------------------

create or replace function public.publish_job(
  p_job_id      uuid,
  p_client_id   uuid,
  p_ip          inet default null,
  p_device_hash text default null
)
returns table (status text, new_status public.job_status, review_trigger text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job          public.jobs%rowtype;
  v_min_budget   bigint  := public.setting_bigint('job.min_budget_paise', 14900);
  v_max_budget   bigint  := public.setting_bigint('job.max_budget_paise', 500000);
  v_review_above bigint  := public.setting_bigint('job.manual_review_above_paise', 200000);
  v_expiry_days  integer := public.setting_int('job.open_expiry_days', 7);
  v_cap          integer;
  v_prior        integer;
  v_trigger      public.moderation_trigger;
  v_status       public.job_status;
  v_now          timestamptz := now();
begin
  -- Two taps on a slow connection should post one job, not two.
  select * into v_job from public.jobs j where j.id = p_job_id for update;

  if not found then
    return query select 'not_found'::text, null::public.job_status, null::text;
    return;
  end if;

  if v_job.client_id <> p_client_id then
    return query select 'forbidden'::text, null::public.job_status, null::text;
    return;
  end if;

  if v_job.status <> 'draft' then
    return query select 'not_a_draft'::text, v_job.status, null::text;
    return;
  end if;

  if v_job.title is null or char_length(v_job.title) < 5
     or v_job.description is null or char_length(v_job.description) < 20
     or v_job.budget_paise is null
     or v_job.deadline_at is null
     or (not v_job.posted_as_other and v_job.category_id is null) then
    return query select 'incomplete'::text, null::public.job_status, null::text;
    return;
  end if;

  if v_job.budget_paise < v_min_budget or v_job.budget_paise > v_max_budget then
    return query select 'budget_out_of_range'::text, null::public.job_status, null::text;
    return;
  end if;

  v_cap := public.max_deadline_days(v_job.budget_paise);
  if v_job.deadline_at <= v_now
     or v_job.deadline_at > v_now + make_interval(days => v_cap) then
    return query select 'deadline_out_of_range'::text, null::public.job_status, null::text;
    return;
  end if;

  -- Spec §5: an uncategorised brief goes to the admin queue, and that queue is
  -- the roadmap for new categories. Spec §10: so does a client's first job
  -- above ₹2,000 — the chargeback rule, and the one that costs real money the
  -- first time it is skipped.
  if v_job.posted_as_other then
    v_trigger := 'other_category';
  elsif v_job.budget_paise >= v_review_above then
    select count(*) into v_prior
    from public.jobs j
    where j.client_id = p_client_id and j.published_at is not null;

    if v_prior = 0 then
      v_trigger := 'first_high_value_job';
    end if;
  end if;

  v_status := case
                when v_trigger is null then 'open'::public.job_status
                else 'pending_moderation'::public.job_status
              end;

  update public.jobs
     set status                 = v_status,
         published_at           = v_now,
         expires_at             = v_now + make_interval(days => v_expiry_days),
         requires_manual_review = v_trigger is not null,
         post_ip                = coalesce(p_ip, post_ip),
         post_device_hash       = coalesce(p_device_hash, post_device_hash)
   where id = p_job_id;

  if v_trigger is not null then
    insert into public.job_moderation (job_id, trigger, status)
    values (p_job_id, v_trigger, 'pending');
  end if;

  -- V1 runs no classifier (0006). The row exists so the queue has the same
  -- shape on the day one is switched on.
  if v_job.posted_as_other then
    insert into public.job_classifications (job_id, status)
    values (p_job_id, 'admin_review');
  end if;

  update public.client_profiles
     set jobs_posted  = jobs_posted + 1,
         first_job_at = coalesce(first_job_at, v_now),
         last_job_at  = v_now
   where profile_id = p_client_id;

  -- The status trigger logs this transition too, but under the service-role key
  -- auth.uid() is null and it records 'system'. This is the row that says a
  -- person did it, and carries what the job looked like when they did.
  insert into public.job_events (
    job_id, actor_id, actor_role, event_type, from_status, to_status, metadata
  )
  values (
    p_job_id, p_client_id, 'client', 'job.published', 'draft', v_status,
    jsonb_build_object(
      'budget_paise',    v_job.budget_paise,
      'deadline_at',     v_job.deadline_at,
      'category_id',     v_job.category_id,
      'posted_as_other', v_job.posted_as_other,
      'review_trigger',  v_trigger
    )
  );

  return query select 'published'::text, v_status, v_trigger::text;
end;
$$;

comment on function public.publish_job is
  'Moves a draft to open, or to pending_moderation when spec §5 (uncategorised) '
  'or spec §10 (first job above ₹2,000) applies, and writes the queue rows that '
  'go with it. service_role only.';

-- Not safe to hand to a signed-in user: it decides whether a job skips
-- moderation. It runs server-side or not at all.
revoke execute on function public.publish_job(uuid, uuid, inet, text)
  from public, anon, authenticated;
grant execute on function public.publish_job(uuid, uuid, inet, text) to service_role;
