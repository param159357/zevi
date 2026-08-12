-- ============================================================================
-- Zevi 0008 — deliveries, revisions, auto-accept
--
-- Every delivery is a row, including the one after a revision, so "what did the
-- worker actually send, and when" survives as evidence. Acceptance is never a
-- user-writable column: accepting releases escrow, so it happens in server code
-- holding the service-role key, inside the same transaction as the ledger
-- entries.
--
-- auto_accept_at is computed once, at delivery, and stored. Deriving it on read
-- would mean every cron pass re-deriving a rule that might have changed since —
-- and a client who was promised 36 hours must get 36 hours.
-- ============================================================================

-- 36 hours under ₹1,000 · 3 days at ₹1,000+ (spec §5).
create or replace function public.auto_accept_deadline(budget_paise bigint, delivered_at timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case
    when budget_paise < 100000 then delivered_at + interval '36 hours'
    else delivered_at + interval '3 days'
  end;
$$;

create table public.job_deliveries (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references public.jobs (id) on delete restrict,
  assignment_id         uuid not null references public.job_assignments (id) on delete restrict,
  worker_id             uuid not null references public.worker_profiles (profile_id) on delete restrict,
  -- 1 = first delivery, 2 = after the free revision, 3+ = by agreement.
  attempt               integer not null default 1 check (attempt >= 1),
  note                  text check (note is null or char_length(note) <= 2000),
  status                public.delivery_status not null default 'pending_review',
  delivered_at          timestamptz not null default now(),
  auto_accept_at        timestamptz not null,
  -- Reminders at 12h/30h (36-hour window) and 24h/60h (3-day window).
  reminder_1_sent_at    timestamptz,
  reminder_2_sent_at    timestamptz,
  accepted_at           timestamptz,
  accepted_by           uuid references public.profiles (id),
  auto_accepted         boolean not null default false,
  revision_requested_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint job_deliveries_attempt_unique unique (job_id, attempt),
  constraint job_deliveries_accepted_stamp check (
    (status = 'accepted') = (accepted_at is not null)
  )
);

-- The auto-accept sweep. Partial: only deliveries still awaiting a decision.
create index job_deliveries_auto_accept_idx on public.job_deliveries (auto_accept_at)
  where status = 'pending_review';
-- The two reminder sweeps hit the same partial index.
create index job_deliveries_reminder_idx on public.job_deliveries (delivered_at)
  where status = 'pending_review' and reminder_2_sent_at is null;
create index job_deliveries_job_idx on public.job_deliveries (job_id, attempt desc);
create index job_deliveries_worker_idx on public.job_deliveries (worker_id, delivered_at desc);
create index job_deliveries_status_idx on public.job_deliveries (status, delivered_at desc);
create index job_deliveries_accepted_at_idx on public.job_deliveries (accepted_at)
  where accepted_at is not null;

create trigger job_deliveries_set_updated_at
  before update on public.job_deliveries
  for each row execute function public.set_updated_at();

-- The auto-accept clock is set by the database, from the job's own budget, so
-- no caller can hand a client a shorter window than the one they were promised.
create or replace function public.stamp_auto_accept_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  budget bigint;
begin
  select j.budget_paise into budget from public.jobs j where j.id = new.job_id;
  new.auto_accept_at := public.auto_accept_deadline(budget, coalesce(new.delivered_at, now()));
  return new;
end;
$$;

create trigger job_deliveries_stamp_deadline
  before insert on public.job_deliveries
  for each row execute function public.stamp_auto_accept_deadline();

-- ----------------------------------------------------------------------------
-- Delivered files
--
-- unlocked_at is the hinge of the whole delivery model: before it, the client
-- sees a watermarked preview (visual work) or a viewer with no download (code,
-- documents). The signed-URL minter reads this column; nothing else decides.
-- ----------------------------------------------------------------------------

create table public.delivery_files (
  delivery_id uuid not null references public.job_deliveries (id) on delete cascade,
  file_id     uuid not null references public.files (id) on delete restrict,
  position    integer not null default 0,
  unlocked_at timestamptz,
  created_at  timestamptz not null default now(),
  primary key (delivery_id, file_id)
);

create index delivery_files_file_idx on public.delivery_files (file_id);

-- ----------------------------------------------------------------------------
-- Revisions — one free, a second only by agreement
-- ----------------------------------------------------------------------------

create table public.job_revisions (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs (id) on delete restrict,
  delivery_id    uuid not null references public.job_deliveries (id) on delete restrict,
  requested_by   uuid not null references public.profiles (id),
  sequence       integer not null check (sequence >= 1),
  -- sequence 1 is free; anything beyond needs the worker to agree, or it
  -- becomes a dispute (spec §5).
  is_free        boolean not null,
  reason         text not null check (char_length(reason) between 10 and 1000),
  status         public.revision_status not null default 'requested',
  worker_response text check (worker_response is null or char_length(worker_response) <= 1000),
  responded_at   timestamptz,
  due_at         timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint job_revisions_sequence_unique unique (job_id, sequence),
  constraint job_revisions_free_is_first check (is_free = (sequence = 1))
);

create index job_revisions_job_idx on public.job_revisions (job_id, sequence);
create index job_revisions_status_idx on public.job_revisions (status, created_at desc);
create index job_revisions_due_idx on public.job_revisions (due_at)
  where status in ('requested', 'accepted_by_worker');

create trigger job_revisions_set_updated_at
  before update on public.job_revisions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.job_deliveries enable row level security;
alter table public.delivery_files enable row level security;
alter table public.job_revisions enable row level security;

create policy "deliveries are visible to both sides"
  on public.job_deliveries for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.is_admin()));

create policy "the assigned worker delivers"
  on public.job_deliveries for insert to authenticated
  with check (
    worker_id = (select auth.uid())
    and status = 'pending_review'
    and exists (
      select 1 from public.job_assignments a
      where a.id = assignment_id
        and a.job_id = job_deliveries.job_id
        and a.worker_id = (select auth.uid())
        and a.status = 'active'
    )
  );

-- Acceptance releases escrow, so it is server work, not an UPDATE from a
-- browser session.
revoke update, delete on public.job_deliveries from anon, authenticated;

create policy "delivered files are visible to both sides"
  on public.delivery_files for select to authenticated
  using (
    exists (
      select 1 from public.job_deliveries d
      where d.id = delivery_id
        and (public.is_job_participant(d.job_id) or public.is_admin())
    )
  );

create policy "workers attach their own delivery files"
  on public.delivery_files for insert to authenticated
  with check (
    exists (
      select 1 from public.job_deliveries d
      where d.id = delivery_id
        and d.worker_id = (select auth.uid())
        and d.status = 'pending_review'
    )
  );

revoke update, delete on public.delivery_files from anon, authenticated;

create policy "revisions are visible to both sides"
  on public.job_revisions for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.is_admin()));

create policy "clients request revisions"
  on public.job_revisions for insert to authenticated
  with check (
    requested_by = (select auth.uid())
    and (select public.is_job_client(job_id))
    and status = 'requested'
  );

create policy "workers answer a revision request"
  on public.job_revisions for update to authenticated
  using (
    status = 'requested'
    and exists (
      select 1 from public.jobs j
      where j.id = job_id and j.assigned_worker_id = (select auth.uid())
    )
  )
  with check (status in ('accepted_by_worker', 'declined_by_worker'));
