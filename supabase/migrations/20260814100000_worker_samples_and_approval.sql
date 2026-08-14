-- ============================================================================
-- Zevi 0027 — sample submission and the approval decision
--
-- 0005 built the tables this needs: `worker_applications` is the unit the queue
-- works through, `worker_samples` holds 3–6 per category with the sole-author
-- confirmation, and the SLA index is already there. What was missing is the two
-- transitions, and both are the same shape as `publish_job()` (0022): a state
-- change that touches several tables at once, where a half-applied version is
-- worse than a refusal.
--
--   submit_worker_application()  draft → submitted. Counts samples per category
--                                against `categories.sample_min`, binds them to
--                                the attempt, starts the 24-hour SLA clock and
--                                moves the worker to 'pending_approval'.
--
--   review_worker_application()  submitted → approved · approved_with_flag ·
--                                rejected. Stamps every pending sample with the
--                                same decision, sets the seven-day resubmission
--                                window on a rejection, and writes the audit row
--                                spec §7 requires on every admin action.
--
-- Both run under the service-role key from a Server Action that has already
-- established who is calling. Neither trusts its caller: the submitter is
-- re-checked against the row, and the reviewer's permission is looked up here
-- rather than taken as read, because `auth.uid()` is null under service_role and
-- `admin_can()` would quietly answer false.
--
-- The direct paths those two functions replace are closed below. A worker could
-- previously UPDATE their own application to 'submitted' with any `sla_due_at`
-- they liked and no samples at all — the policy checked who they were, never
-- what they were writing.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sample storage
--
-- Same arrangement as job attachments (0023): the object goes straight from the
-- browser to Storage, and the `public.files` row that makes it a sample is
-- written afterwards, server-side, against what Storage reports. Objects are
-- keyed `worker-samples/<worker id>/<category id>/<uuid>.<ext>` and both
-- policies anchor on the first two segments.
--
-- No public read policy. Spec §6 watermarks samples on display, and until the
-- preview pipeline exists the only readers are the worker who uploaded them and
-- a reviewer, who gets a short-lived signed URL minted server-side.
-- ----------------------------------------------------------------------------

drop policy if exists "workers upload their own samples" on storage.objects;
drop policy if exists "workers read their own samples" on storage.objects;
drop policy if exists "workers remove their own samples" on storage.objects;

create policy "workers upload their own samples"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'worker-samples'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "workers read their own samples"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'worker-samples'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

create policy "workers remove their own samples"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'zevi-uploads'
    and (storage.foldername(name))[1] = 'worker-samples'
    and (storage.foldername(name))[2] = (select auth.uid())::text
  );

-- ----------------------------------------------------------------------------
-- Samples are editable up to the moment they are submitted
--
-- 0005 allowed a worker to add, edit and withdraw their own pending samples,
-- which stayed true while the application sat in the review queue: the six
-- files an admin approved need not be the six that were submitted. The lock is
-- a function rather than a subquery in three policies so there is one answer to
-- "may this worker still change their portfolio", and a rejection unlocks it
-- again for the single resubmission spec §6 allows.
-- ----------------------------------------------------------------------------

create or replace function public.worker_samples_locked(uid uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.worker_applications wa
    where wa.worker_id = coalesce(uid, (select auth.uid()))
      and wa.status in ('submitted', 'approved', 'approved_with_flag')
  );
$$;

comment on function public.worker_samples_locked is
  'True once a worker has an application in review or approved. Their samples '
  'are frozen from that moment; a rejection unlocks them for the resubmission.';

grant execute on function public.worker_samples_locked(uuid) to authenticated;

drop policy "workers manage their own pending samples" on public.worker_samples;
drop policy "workers edit their own pending samples" on public.worker_samples;
drop policy "workers withdraw their own pending samples" on public.worker_samples;

create policy "workers add samples while their application is open"
  on public.worker_samples for insert to authenticated
  with check (
    worker_id = (select auth.uid())
    and status = 'pending'
    and not (select public.worker_samples_locked())
  );

create policy "workers edit samples while their application is open"
  on public.worker_samples for update to authenticated
  using (
    worker_id = (select auth.uid())
    and status = 'pending'
    and not (select public.worker_samples_locked())
  )
  with check (worker_id = (select auth.uid()) and status = 'pending');

create policy "workers withdraw samples while their application is open"
  on public.worker_samples for delete to authenticated
  using (
    worker_id = (select auth.uid())
    and status = 'pending'
    and not (select public.worker_samples_locked())
  );

-- Reviewing is a decision about the whole attempt, taken in the function below.
revoke update on public.worker_samples from anon, authenticated;
grant update (caption, position) on public.worker_samples to authenticated;

-- ----------------------------------------------------------------------------
-- Applications leave 'draft' one way only
--
-- The insert policy stays — `saveWorkerCategories` opens the draft — but it is
-- narrowed to a first attempt in 'draft'. A second attempt is created by
-- `submit_worker_application()` and by nothing else, so the seven-day wait
-- cannot be skipped by inserting the row that follows it.
-- ----------------------------------------------------------------------------

drop policy "workers create their own application" on public.worker_applications;
drop policy "workers edit their own draft" on public.worker_applications;

create policy "workers open their own application"
  on public.worker_applications for insert to authenticated
  with check (
    worker_id = (select auth.uid())
    and status = 'draft'
    and attempt = 1
    and submitted_at is null
    and sla_due_at is null
  );

revoke update, delete on public.worker_applications from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Admins reviewing people need to see them
--
-- 0002 states the rule this narrows: `profiles` is PII and no policy exposes a
-- row to another user. A reviewer is not "another user" in the sense that rule
-- was written for — spec §6 has them check the full legal name against the ID
-- on the samples, and spec §7 gives the Users module full history. Stating it
-- as a policy keeps the boundary in the database, where it can be read, rather
-- than in whichever query happens to hold the service-role key.
--
-- Deliberately asymmetric: `manage_users` sees everyone, `review_workers` sees
-- only workers. A sample reviewer has no business reading a client's row.
-- ----------------------------------------------------------------------------

create policy "admins with a people permission read profiles"
  on public.profiles for select to authenticated
  using (
    (select public.admin_can('manage_users'))
    or ((select public.admin_can('review_workers')) and is_worker)
  );

-- ----------------------------------------------------------------------------
-- submit_worker_application
--
-- Returns one row. `status` is one of:
--   submitted           — sla_due_at carries the 24-hour deadline
--   not_a_worker        — no worker_profiles row
--   no_categories       — nothing chosen at signup
--   not_enough_samples  — detail names the first category short of its minimum
--   already_submitted · already_approved
--   resubmit_too_soon   — detail carries the timestamp they may retry from
--   no_attempts_left    — spec §6 allows one resubmission, and it was used
-- ----------------------------------------------------------------------------

create or replace function public.submit_worker_application(p_worker_id uuid)
returns table (status text, application_id uuid, sla_due_at timestamptz, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app       public.worker_applications%rowtype;
  v_sla_hours integer := public.setting_int('worker.approval_sla_hours', 24);
  v_short     record;
  v_wait      timestamptz;
  v_rejected  integer;
  v_due       timestamptz;
  v_now       timestamptz := now();
begin
  if not exists (
    select 1 from public.worker_profiles wp where wp.profile_id = p_worker_id
  ) then
    return query select 'not_a_worker'::text, null::uuid, null::timestamptz, null::text;
    return;
  end if;

  -- The categories page opens the draft, but a signup interrupted between the
  -- two leaves a worker with samples and no application. Opening it here means
  -- that recovers itself rather than needing support.
  insert into public.worker_applications (worker_id, attempt, status)
  values (p_worker_id, 1, 'draft')
  on conflict (worker_id, attempt) do nothing;

  -- Two taps on a slow connection should start one review, not two.
  select * into v_app
  from public.worker_applications wa
  where wa.worker_id = p_worker_id
  order by wa.attempt desc
  limit 1
  for update;

  if v_app.status in ('approved', 'approved_with_flag') then
    return query select 'already_approved'::text, v_app.id, v_app.sla_due_at, null::text;
    return;
  end if;

  if v_app.status = 'submitted' then
    return query select 'already_submitted'::text, v_app.id, v_app.sla_due_at, null::text;
    return;
  end if;

  -- Read off every rejected attempt rather than the newest row, so a draft
  -- inserted alongside a rejection cannot be used to skip the wait.
  select count(*), max(wa.resubmit_after)
    into v_rejected, v_wait
  from public.worker_applications wa
  where wa.worker_id = p_worker_id and wa.status = 'rejected';

  if v_rejected > 0 then
    if v_rejected >= 2 or (v_app.attempt >= 2 and v_app.status = 'rejected') then
      return query select 'no_attempts_left'::text, v_app.id, null::timestamptz, null::text;
      return;
    end if;

    if v_wait is not null and v_now < v_wait then
      return query
        select 'resubmit_too_soon'::text, v_app.id, null::timestamptz, v_wait::text;
      return;
    end if;
  end if;

  -- A rejected attempt is never reopened: the decision on it is the record of
  -- what was wrong, and spec §6 counts resubmissions.
  if v_app.status = 'rejected' then
    insert into public.worker_applications (worker_id, attempt, status)
    values (p_worker_id, v_app.attempt + 1, 'draft')
    returning * into v_app;
  end if;

  if not exists (
    select 1 from public.worker_categories wc where wc.worker_id = p_worker_id
  ) then
    return query select 'no_categories'::text, v_app.id, null::timestamptz, null::text;
    return;
  end if;

  -- The floor is a submit-time rule (0005): a worker builds up to it, and this
  -- is the moment it has to hold for every category they chose.
  select c.name, c.sample_min into v_short
  from public.worker_categories wc
  join public.categories c on c.id = wc.category_id
  where (
    select count(*)
    from public.worker_samples s
    where s.worker_id = p_worker_id
      and s.category_id = wc.category_id
      and s.status <> 'rejected'
  ) < c.sample_min
  order by c.position, c.name
  limit 1;

  if found then
    return query select 'not_enough_samples'::text, v_app.id, null::timestamptz, v_short.name;
    return;
  end if;

  v_due := v_now + make_interval(hours => v_sla_hours);

  -- Binds this attempt's evidence to it. A resubmission carries the samples
  -- that survived the rejection plus whatever was added since.
  update public.worker_samples s
     set application_id = v_app.id
   where s.worker_id = p_worker_id
     and s.status = 'pending'
     and s.application_id is distinct from v_app.id;

  update public.worker_applications
     set status       = 'submitted',
         submitted_at = v_now,
         sla_due_at   = v_due
   where id = v_app.id;

  update public.worker_profiles
     set status = 'pending_approval'
   where profile_id = p_worker_id;

  return query select 'submitted'::text, v_app.id, v_due, null::text;
end;
$$;

comment on function public.submit_worker_application is
  'Moves a worker application from draft to submitted once every category has '
  'its minimum samples, and starts the 24-hour SLA clock. service_role only.';

revoke execute on function public.submit_worker_application(uuid)
  from public, anon, authenticated;
grant execute on function public.submit_worker_application(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- review_worker_application
--
-- The three outcomes in spec §6: approve · approve-with-flag (watched on first
-- delivery) · reject with reason. A reason is required on all three, because
-- the audit row spec §7 mandates has nowhere else to get one.
--
-- Returns one row. `status` is one of:
--   reviewed · not_found · forbidden · not_submitted
--   invalid_decision · reason_required
-- ----------------------------------------------------------------------------

create or replace function public.review_worker_application(
  p_application_id uuid,
  p_reviewer_id    uuid,
  p_decision       text,
  p_reason         text,
  p_internal_note  text default null,
  p_ip             inet default null
)
returns table (status text, new_status public.worker_application_status, worker_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app          public.worker_applications%rowtype;
  v_worker       public.worker_profiles%rowtype;
  v_app_status   public.worker_application_status;
  v_worker_status public.worker_status;
  v_sample_status public.sample_status;
  v_flagged      boolean := false;
  v_resubmit     timestamptz;
  v_wait_days    integer := public.setting_int('worker.resubmit_after_days', 7);
  v_reason       text := nullif(btrim(p_reason), '');
  v_now          timestamptz := now();
begin
  if p_decision not in ('approve', 'approve_with_flag', 'reject') then
    return query select 'invalid_decision'::text, null::public.worker_application_status, null::uuid;
    return;
  end if;

  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::public.worker_application_status, null::uuid;
    return;
  end if;

  -- Under the service-role key auth.uid() is null, so admin_can() would answer
  -- false for a super admin. The permission is looked up against the id the
  -- Server Action established instead.
  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_reviewer_id
      and au.is_active
      and (r.is_super or 'review_workers' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::public.worker_application_status, null::uuid;
    return;
  end if;

  -- Two reviewers on the queue at once should produce one decision.
  select * into v_app
  from public.worker_applications wa
  where wa.id = p_application_id
  for update;

  if not found then
    return query select 'not_found'::text, null::public.worker_application_status, null::uuid;
    return;
  end if;

  if v_app.status <> 'submitted' then
    return query select 'not_submitted'::text, v_app.status, v_app.worker_id;
    return;
  end if;

  select * into v_worker
  from public.worker_profiles wp
  where wp.profile_id = v_app.worker_id;

  case p_decision
    when 'approve' then
      v_app_status := 'approved';
      v_worker_status := 'approved';
      v_sample_status := 'approved';
    when 'approve_with_flag' then
      v_app_status := 'approved_with_flag';
      v_worker_status := 'approved_with_flag';
      v_sample_status := 'approved';
      v_flagged := true;
    else
      v_app_status := 'rejected';
      v_worker_status := 'rejected';
      v_sample_status := 'rejected';
      -- Spec §6: one resubmission, after seven days. A second rejection ends it,
      -- and a null window is how the submit function reads "no way back".
      if v_app.attempt < 2 then
        v_resubmit := v_now + make_interval(days => v_wait_days);
      end if;
  end case;

  update public.worker_samples s
     set status           = v_sample_status,
         reviewed_by      = p_reviewer_id,
         reviewed_at      = v_now,
         rejection_reason = case when v_sample_status = 'rejected' then v_reason else null end
   where s.application_id = v_app.id
     and s.status = 'pending';

  update public.worker_applications
     set status                = v_app_status,
         reviewed_by           = p_reviewer_id,
         reviewed_at           = v_now,
         decision_reason       = v_reason,
         internal_note         = coalesce(nullif(btrim(p_internal_note), ''), internal_note),
         flagged_for_first_job = v_flagged,
         resubmit_after        = v_resubmit
   where id = v_app.id;

  update public.worker_profiles
     set status      = v_worker_status,
         approved_at = case
                         when v_worker_status in ('approved', 'approved_with_flag')
                           then coalesce(approved_at, v_now)
                         else approved_at
                       end
   where profile_id = v_app.worker_id;

  -- Permanent, reason mandatory (spec §7). The before/after pair is what makes
  -- a decision arguable months later, when the only other record is a worker
  -- saying they were never told why.
  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_reviewer_id,
    'worker_application.' || p_decision,
    'worker_applications',
    v_app.id,
    v_reason,
    jsonb_build_object(
      'application_status', v_app.status,
      'worker_status',      v_worker.status,
      'attempt',            v_app.attempt,
      'submitted_at',       v_app.submitted_at,
      'sla_due_at',         v_app.sla_due_at
    ),
    jsonb_build_object(
      'application_status',    v_app_status,
      'worker_status',         v_worker_status,
      'flagged_for_first_job', v_flagged,
      'resubmit_after',        v_resubmit,
      'internal_note',         nullif(btrim(p_internal_note), '') is not null
    ),
    p_ip
  );

  return query select 'reviewed'::text, v_app_status, v_app.worker_id;
end;
$$;

comment on function public.review_worker_application is
  'Approve, approve-with-flag or reject a submitted worker application, stamping '
  'its samples and writing the audit row. service_role only.';

revoke execute on function public.review_worker_application(uuid, uuid, text, text, text, inet)
  from public, anon, authenticated;
grant execute on function public.review_worker_application(uuid, uuid, text, text, text, inet)
  to service_role;
