-- ============================================================================
-- Zevi 0007 — opt-ins, shortlists, assignment
--
-- The assignment is the moment money moves, so it is the one place in the
-- schema with a real lock. `claim_job_assignment()` takes SELECT … FOR UPDATE
-- on the job row before it checks anything, and a partial unique index makes
-- "one active assignment per job" true even if the lock were somehow skipped.
-- Belt and braces, because a double assignment means paying two workers for one
-- ₹400 job and refunding a client who now distrusts the platform.
--
-- Shortlists are stored, not computed on read. Which five workers a client was
-- shown, in which slots, is evidence in a dispute and the raw material for
-- tuning the algorithm later — it must not vanish when ratings change.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Opt-ins
-- ----------------------------------------------------------------------------

create table public.job_opt_ins (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs (id) on delete cascade,
  worker_id        uuid not null references public.worker_profiles (profile_id) on delete cascade,
  status           public.opt_in_status not null default 'active',
  -- The three short fields (spec §6). The third one is the anti-slop defence:
  -- a generic answer to "one thing you noticed in this brief" is visible.
  software         text not null check (char_length(software) between 2 and 200),
  turnaround       text not null check (char_length(turnaround) between 2 and 200),
  noticed_detail   text not null check (char_length(noticed_detail) between 10 and 300),
  -- 20-second dwell timer. Client-supplied and therefore advisory, but stored
  -- so a worker who opts into forty jobs in a minute is visible in the data.
  brief_opened_at  timestamptz not null,
  -- AI relevance scores: 40% note, 60% delivery history. Null in V1, which
  -- sorts opted-in workers by rating instead.
  note_score       numeric(5, 4) check (note_score is null or note_score between 0 and 1),
  history_score    numeric(5, 4) check (history_score is null or history_score between 0 and 1),
  rank_score       numeric(5, 4) check (rank_score is null or rank_score between 0 and 1),
  withdrawn_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint job_opt_ins_unique unique (job_id, worker_id),
  -- 300 characters total across the three fields.
  constraint job_opt_ins_total_length check (
    char_length(software) + char_length(turnaround) + char_length(noticed_detail) <= 300
  ),
  constraint job_opt_ins_dwell check (created_at - brief_opened_at >= interval '20 seconds')
);

-- The client's shortlist screen.
create index job_opt_ins_job_idx on public.job_opt_ins (job_id, status, created_at);
-- "My opt-ins", and the active-cap check.
create index job_opt_ins_worker_idx on public.job_opt_ins (worker_id, status, created_at desc);
create index job_opt_ins_rank_idx on public.job_opt_ins (job_id, rank_score desc nulls last)
  where status in ('active', 'shortlisted');

create trigger job_opt_ins_set_updated_at
  before update on public.job_opt_ins
  for each row execute function public.set_updated_at();

-- Keeps jobs.opt_in_count and worker_profiles.active_opt_ins honest, and
-- enforces the active-opt-in cap. Recomputes rather than incrementing: an
-- off-by-one in a counter shown on every feed card is not worth the speed.
create or replace function public.sync_opt_in_counters()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  touched   public.job_opt_ins;
  live      integer;
  cap       integer;
begin
  if tg_op = 'DELETE' then
    touched := old;
  else
    touched := new;
  end if;

  update public.jobs j
     set opt_in_count = (
       select count(*) from public.job_opt_ins o
       where o.job_id = touched.job_id and o.status in ('active', 'shortlisted', 'selected')
     )
   where j.id = touched.job_id;

  select count(*) into live
  from public.job_opt_ins o
  where o.worker_id = touched.worker_id and o.status in ('active', 'shortlisted');

  update public.worker_profiles wp
     set active_opt_ins = live
   where wp.profile_id = touched.worker_id;

  if tg_op <> 'DELETE' then
    select coalesce(ws.opt_in_limit_override, public.setting_int('matching.max_active_opt_ins', 5))
      into cap
    from public.worker_state ws
    where ws.profile_id = touched.worker_id;

    cap := coalesce(cap, public.setting_int('matching.max_active_opt_ins', 5));

    if live > cap then
      raise exception 'a worker may hold at most % active opt-ins (attempted %)', cap, live
        using errcode = 'check_violation';
    end if;
  end if;

  return null;
end;
$$;

create trigger job_opt_ins_sync_counters
  after insert or update of status or delete on public.job_opt_ins
  for each row execute function public.sync_opt_in_counters();

alter table public.job_opt_ins enable row level security;

create policy "workers read their own opt-ins"
  on public.job_opt_ins for select to authenticated
  using (worker_id = (select auth.uid()));

-- The client sees who opted in — that is the shortlist.
create policy "clients read opt-ins on their own jobs"
  on public.job_opt_ins for select to authenticated
  using ((select public.is_job_client(job_id)));

create policy "admins read every opt-in"
  on public.job_opt_ins for select to authenticated
  using ((select public.is_admin()));

create policy "approved workers opt into open jobs"
  on public.job_opt_ins for insert to authenticated
  with check (
    worker_id = (select auth.uid())
    and status = 'active'
    and (select public.is_active_worker())
    and exists (
      select 1 from public.jobs j
      where j.id = job_id
        and j.status = 'open'
        and j.category_id is not null
        and public.worker_works_in_category(j.category_id)
    )
  );

create policy "workers withdraw their own opt-ins"
  on public.job_opt_ins for update to authenticated
  using (worker_id = (select auth.uid()) and status in ('active', 'shortlisted'))
  with check (worker_id = (select auth.uid()) and status = 'withdrawn');

-- A worker who opted in keeps sight of the job after it leaves the open feed.
create policy "opted-in workers keep reading the job"
  on public.jobs for select to authenticated
  using (
    exists (
      select 1 from public.job_opt_ins o
      where o.job_id = jobs.id and o.worker_id = (select auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- Shortlists
-- ----------------------------------------------------------------------------

create table public.job_shortlists (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.jobs (id) on delete cascade,
  algorithm_version text not null default 'v1-rating-sort',
  is_current        boolean not null default true,
  generated_at      timestamptz not null default now()
);

create unique index job_shortlists_current_idx on public.job_shortlists (job_id) where is_current;
create index job_shortlists_job_idx on public.job_shortlists (job_id, generated_at desc);

create table public.job_shortlist_entries (
  id            uuid primary key default gen_random_uuid(),
  shortlist_id  uuid not null references public.job_shortlists (id) on delete cascade,
  worker_id     uuid not null references public.worker_profiles (profile_id) on delete restrict,
  opt_in_id     uuid not null references public.job_opt_ins (id) on delete cascade,
  slot          public.shortlist_slot not null,
  position      integer not null check (position between 1 and 5),
  score         numeric(5, 4),
  note_score    numeric(5, 4),
  history_score numeric(5, 4),
  created_at    timestamptz not null default now(),
  constraint job_shortlist_entries_worker_unique unique (shortlist_id, worker_id),
  constraint job_shortlist_entries_position_unique unique (shortlist_id, position)
);

create index job_shortlist_entries_worker_idx
  on public.job_shortlist_entries (worker_id, created_at desc);
-- Newest-slot rotation: how many shortlists has this worker occupied the slot
-- in, and since when.
create index job_shortlist_entries_newest_slot_idx
  on public.job_shortlist_entries (worker_id, created_at desc) where slot = 'newest';

alter table public.job_shortlists enable row level security;
alter table public.job_shortlist_entries enable row level security;

create policy "clients read their own shortlist"
  on public.job_shortlists for select to authenticated
  using ((select public.is_job_client(job_id)) or (select public.is_admin()));

create policy "shortlist entries follow the shortlist"
  on public.job_shortlist_entries for select to authenticated
  using (
    worker_id = (select auth.uid())
    or exists (
      select 1 from public.job_shortlists s
      where s.id = shortlist_id and public.is_job_client(s.job_id)
    )
    or (select public.is_admin())
  );

revoke insert, update, delete on public.job_shortlists from anon, authenticated;
revoke insert, update, delete on public.job_shortlist_entries from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Assignments
-- ----------------------------------------------------------------------------

create table public.job_assignments (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs (id) on delete restrict,
  worker_id    uuid not null references public.worker_profiles (profile_id) on delete restrict,
  opt_in_id    uuid references public.job_opt_ins (id) on delete set null,
  source       public.assignment_source not null default 'shortlist',
  status       public.assignment_status not null default 'active',
  -- FK added in 0012, once public.payments exists. Payment happens at
  -- selection, so an assignment without one is an admin or rehire path.
  payment_id   uuid,
  assigned_at  timestamptz not null default now(),
  ended_at     timestamptz,
  ended_reason text,
  created_at   timestamptz not null default now()
);

-- The structural guarantee behind "no double assignment".
create unique index job_assignments_one_active_idx
  on public.job_assignments (job_id) where status = 'active';
create index job_assignments_worker_idx on public.job_assignments (worker_id, status, assigned_at desc);
create index job_assignments_job_idx on public.job_assignments (job_id, assigned_at desc);
create index job_assignments_payment_idx on public.job_assignments (payment_id)
  where payment_id is not null;

alter table public.job_assignments enable row level security;

create policy "assignments are visible to both sides"
  on public.job_assignments for select to authenticated
  using (
    worker_id = (select auth.uid())
    or (select public.is_job_client(job_id))
    or (select public.is_admin())
  );

revoke insert, update, delete on public.job_assignments from anon, authenticated;

-- ----------------------------------------------------------------------------
-- claim_job_assignment — the locked path
--
-- Callable by the job's client (from the "pick this worker" action, after the
-- payment is captured in the same transaction) or with the service-role key
-- from the Razorpay webhook. Never by a worker.
-- ----------------------------------------------------------------------------

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
     set status = case when o.worker_id = p_worker_id then 'selected' else 'not_selected' end
   where o.job_id = p_job_id
     and o.status in ('active', 'shortlisted');

  insert into public.job_events (job_id, actor_id, actor_role, event_type, metadata)
  values (
    p_job_id,
    caller,
    case when caller = target.client_id then 'client' when caller is null then 'system' else 'admin' end,
    'job.assigned',
    jsonb_build_object('worker_id', p_worker_id, 'source', p_source)
  );

  return claim;
end;
$$;

revoke execute on function public.claim_job_assignment(uuid, uuid, uuid, uuid, public.assignment_source)
  from public, anon;
grant execute on function public.claim_job_assignment(uuid, uuid, uuid, uuid, public.assignment_source)
  to authenticated, service_role;
