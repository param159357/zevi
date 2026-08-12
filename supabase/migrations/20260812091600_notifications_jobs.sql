-- ============================================================================
-- Zevi 0017 — notification centre, email outbox, background jobs
--
-- Email is for the essential events only (spec §15); everything else is an
-- in-site notification. The notification centre is out of V1, but the table is
-- here because notifications are written by the same server actions that send
-- the emails, and adding a write later means revisiting every one of them.
--
-- The outbox exists because SES can fail and because reminders are scheduled,
-- not immediate: the auto-accept nudges go out at 12h/30h and 24h/60h. A row is
-- queued with a `scheduled_for` and picked up by a worker — sending inline from
-- a request would tie a client's "accept" click to Amazon's availability.
-- ============================================================================

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  type       public.notification_type not null,
  title      text not null,
  body       text,
  job_id     uuid references public.jobs (id) on delete cascade,
  action_url text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- The bell: unread first, newest first.
create index notifications_unread_idx on public.notifications (profile_id, created_at desc)
  where read_at is null;
create index notifications_profile_idx on public.notifications (profile_id, created_at desc);
create index notifications_job_idx on public.notifications (job_id) where job_id is not null;

-- ----------------------------------------------------------------------------
-- Email outbox
-- ----------------------------------------------------------------------------

create table public.email_outbox (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid references public.profiles (id) on delete set null,
  to_email        text not null,
  template        text not null,
  -- Job ID in every subject line (spec §15).
  subject         text not null,
  payload         jsonb not null default '{}'::jsonb,
  job_id          uuid references public.jobs (id) on delete set null,
  status          public.email_status not null default 'queued',
  scheduled_for   timestamptz not null default now(),
  attempts        integer not null default 0 check (attempts >= 0),
  sent_at         timestamptz,
  provider_message_id text,
  error           text,
  -- Stops a retried webhook from sending the same email twice.
  dedupe_key      text unique,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The sender's claim query.
create index email_outbox_due_idx on public.email_outbox (scheduled_for)
  where status = 'queued';
create index email_outbox_profile_idx on public.email_outbox (profile_id, created_at desc)
  where profile_id is not null;
create index email_outbox_job_idx on public.email_outbox (job_id) where job_id is not null;
-- Deliverability watch: SPF/DKIM problems show up here first.
create index email_outbox_failures_idx on public.email_outbox (updated_at)
  where status in ('failed', 'bounced', 'complained');

create trigger email_outbox_set_updated_at
  before update on public.email_outbox
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Background jobs — payouts, emails, file processing (spec §3)
-- ----------------------------------------------------------------------------

create table public.background_jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        public.background_job_status not null default 'queued',
  run_at        timestamptz not null default now(),
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 5 check (max_attempts > 0),
  -- Claimed-at plus a worker id: a stale lock is recoverable without a human.
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  completed_at  timestamptz,
  -- Two workers must never both run "close the payout batch".
  dedupe_key    text unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index background_jobs_due_idx on public.background_jobs (run_at)
  where status = 'queued';
create index background_jobs_stale_lock_idx on public.background_jobs (locked_at)
  where status = 'running';
create index background_jobs_kind_idx on public.background_jobs (kind, created_at desc);
create index background_jobs_dead_idx on public.background_jobs (updated_at) where status = 'dead';

create trigger background_jobs_set_updated_at
  before update on public.background_jobs
  for each row execute function public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.notifications enable row level security;
alter table public.email_outbox enable row level security;
alter table public.background_jobs enable row level security;

create policy "users read their own notifications"
  on public.notifications for select to authenticated
  using (profile_id = (select auth.uid()));

create policy "users mark their own notifications read"
  on public.notifications for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

revoke update on public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;
revoke insert, delete on public.notifications from anon, authenticated;

-- The outbox and the queue are infrastructure. Nothing in a browser session
-- has any business reading either.
revoke all on public.email_outbox from anon, authenticated;
revoke all on public.background_jobs from anon, authenticated;
