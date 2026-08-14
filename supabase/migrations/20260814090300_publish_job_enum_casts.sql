-- ============================================================================
-- Zevi 0025 — publish_job: cast the enum literals
--
-- 0022's final INSERT into `job_events` failed at runtime:
--
--     column "actor_role" is of type public.party_role but expression is of
--     type text                                                        (42804)
--
-- The same INSERT written inside a trigger function in 0006 is fine, because
-- there every value comes from `new.*`. In `publish_job()` the row is built
-- from function parameters, and a bare 'client' alongside them does not get
-- resolved against the column's enum type the way it does in a plain statement.
--
-- So every enum literal in this function is now cast at the point it is
-- written. That is worth doing even where it currently works: the ones in the
-- moderation and classification inserts executed only because they sit earlier
-- in the same transaction and never got the chance to fail.
--
-- Only the casts change. The logic is 0022's, unaltered.
-- ============================================================================

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
    v_trigger := 'other_category'::public.moderation_trigger;
  elsif v_job.budget_paise >= v_review_above then
    select count(*) into v_prior
    from public.jobs j
    where j.client_id = p_client_id and j.published_at is not null;

    if v_prior = 0 then
      v_trigger := 'first_high_value_job'::public.moderation_trigger;
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
    values (p_job_id, v_trigger, 'pending'::public.moderation_status);
  end if;

  -- V1 runs no classifier (0006). The row exists so the queue has the same
  -- shape on the day one is switched on.
  if v_job.posted_as_other then
    insert into public.job_classifications (job_id, status)
    values (p_job_id, 'admin_review'::public.classification_status);
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
    p_job_id,
    p_client_id,
    'client'::public.party_role,
    'job.published',
    'draft'::public.job_status,
    v_status,
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

revoke execute on function public.publish_job(uuid, uuid, inet, text)
  from public, anon, authenticated;
grant execute on function public.publish_job(uuid, uuid, inet, text) to service_role;
