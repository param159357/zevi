-- ============================================================================
-- Zevi 0016 — reports, support, and the risk model
--
-- Reports point at one of five things. Rather than a polymorphic
-- (target_type, target_id) pair with no referential integrity, there is a
-- nullable FK per target and a CHECK that exactly one is set. Slightly wider
-- table, but a report can never point at a job that no longer exists.
--
-- The risk model is deliberately arithmetic, not machine learning (spec §10):
-- shared device, shared IP, shared payout destination, suspiciously fast
-- completion, always five stars, no chat, pairs who only transact with each
-- other. Each is a countable fact, stored where an admin can see it on the user
-- record and argue with it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Reports
-- ----------------------------------------------------------------------------

create table public.reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid not null references public.profiles (id) on delete restrict,
  reason            public.report_reason not null,
  description       text not null check (char_length(description) between 10 and 2000),
  status            public.report_status not null default 'open',
  -- Exactly one of these five.
  reported_profile_id uuid references public.profiles (id) on delete restrict,
  job_id            uuid references public.jobs (id) on delete restrict,
  message_id        uuid references public.messages (id) on delete restrict,
  sample_id         uuid references public.worker_samples (id) on delete restrict,
  delivery_id       uuid references public.job_deliveries (id) on delete restrict,
  priority          integer not null default 0 check (priority between 0 and 3),
  assigned_admin_id uuid references public.profiles (id),
  resolution_note   text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint reports_single_target check (
    (reported_profile_id is not null)::int
    + (job_id is not null)::int
    + (message_id is not null)::int
    + (sample_id is not null)::int
    + (delivery_id is not null)::int = 1
  )
);

-- The admin queue: highest priority, oldest first.
create index reports_queue_idx on public.reports (priority desc, created_at)
  where status in ('open', 'reviewing');
create index reports_reporter_idx on public.reports (reporter_id, created_at desc);
create index reports_reason_idx on public.reports (reason, created_at desc);
create index reports_reported_profile_idx on public.reports (reported_profile_id, created_at desc)
  where reported_profile_id is not null;
create index reports_job_idx on public.reports (job_id) where job_id is not null;
create index reports_sample_idx on public.reports (sample_id) where sample_id is not null;
create index reports_message_idx on public.reports (message_id) where message_id is not null;
create index reports_delivery_idx on public.reports (delivery_id) where delivery_id is not null;
create index reports_assigned_idx on public.reports (assigned_admin_id, status)
  where assigned_admin_id is not null;

create trigger reports_set_updated_at
  before update on public.reports
  for each row execute function public.set_updated_at();

alter table public.user_sanctions
  add constraint user_sanctions_report_fk
  foreign key (report_id) references public.reports (id) on delete set null;

-- ----------------------------------------------------------------------------
-- Support — a Help link on every job page, ticket tied to the job, 48h SLA
-- ----------------------------------------------------------------------------

create table public.support_tickets (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles (id) on delete restrict,
  job_id            uuid references public.jobs (id) on delete set null,
  subject           text not null check (char_length(subject) between 3 and 200),
  status            public.ticket_status not null default 'open',
  priority          integer not null default 0 check (priority between 0 and 3),
  sla_due_at        timestamptz not null,
  assigned_admin_id uuid references public.profiles (id),
  first_reply_at    timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index support_tickets_queue_idx on public.support_tickets (sla_due_at)
  where status in ('open', 'waiting_on_admin');
create index support_tickets_profile_idx on public.support_tickets (profile_id, created_at desc);
create index support_tickets_job_idx on public.support_tickets (job_id) where job_id is not null;
create index support_tickets_assigned_idx on public.support_tickets (assigned_admin_id, status)
  where assigned_admin_id is not null;

create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

create table public.support_messages (
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references public.support_tickets (id) on delete cascade,
  author_id  uuid not null references public.profiles (id) on delete restrict,
  is_staff   boolean not null default false,
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index support_messages_ticket_idx on public.support_messages (ticket_id, created_at);

-- ----------------------------------------------------------------------------
-- Device and network fingerprints
--
-- The point is the collision, not the value: two accounts on one device, or a
-- client and their worker on one IP, is the cheapest fraud signal there is.
-- ----------------------------------------------------------------------------

create table public.user_devices (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  device_hash  text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  user_agent   text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  seen_count   integer not null default 1 check (seen_count > 0),
  constraint user_devices_unique unique (profile_id, device_hash)
);

-- "Who else uses this device" — the lookup that matters.
create index user_devices_hash_idx on public.user_devices (device_hash);
create index user_devices_profile_idx on public.user_devices (profile_id, last_seen_at desc);

create table public.user_ip_events (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  ip         inet not null,
  context    text not null,
  created_at timestamptz not null default now()
);

create index user_ip_events_ip_idx on public.user_ip_events (ip, created_at desc);
create index user_ip_events_profile_idx on public.user_ip_events (profile_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Risk flags and pair signals
-- ----------------------------------------------------------------------------

create table public.risk_flags (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid not null references public.profiles (id) on delete cascade,
  -- The other side of a shared-device / closed-pair signal, when there is one.
  counterparty_id uuid references public.profiles (id) on delete cascade,
  job_id          uuid references public.jobs (id) on delete set null,
  kind            public.risk_flag_kind not null,
  severity        integer not null default 1 check (severity between 1 and 3),
  detail          jsonb not null default '{}'::jsonb,
  status          public.risk_flag_status not null default 'open',
  reviewed_by     uuid references public.profiles (id),
  reviewed_at     timestamptz,
  review_note     text,
  created_at      timestamptz not null default now()
);

create index risk_flags_profile_idx on public.risk_flags (profile_id, created_at desc);
create index risk_flags_open_idx on public.risk_flags (severity desc, created_at)
  where status = 'open';
create index risk_flags_kind_idx on public.risk_flags (kind, created_at desc);
create index risk_flags_counterparty_idx on public.risk_flags (counterparty_id)
  where counterparty_id is not null;

-- One row per pair who have transacted, holding the numbers that expose
-- collusion: how often, how fast, how highly rated, how little they talk.
create table public.user_pair_signals (
  client_id            uuid not null references public.profiles (id) on delete cascade,
  worker_id            uuid not null references public.profiles (id) on delete cascade,
  jobs_together        integer not null default 0 check (jobs_together >= 0),
  total_value_paise    bigint not null default 0 check (total_value_paise >= 0),
  avg_completion_seconds integer,
  avg_rating           numeric(3, 2),
  five_star_count      integer not null default 0,
  total_messages       integer not null default 0,
  shared_device        boolean not null default false,
  shared_ip            boolean not null default false,
  shared_payout_destination boolean not null default false,
  first_job_at         timestamptz,
  last_job_at          timestamptz,
  updated_at           timestamptz not null default now(),
  primary key (client_id, worker_id)
);

-- Pairs who only ever transact with each other surface at the top of this.
create index user_pair_signals_volume_idx on public.user_pair_signals (jobs_together desc);
create index user_pair_signals_worker_idx on public.user_pair_signals (worker_id, jobs_together desc);
create index user_pair_signals_shared_idx on public.user_pair_signals (updated_at desc)
  where shared_device or shared_ip or shared_payout_destination;

create trigger user_pair_signals_set_updated_at
  before update on public.user_pair_signals
  for each row execute function public.set_updated_at();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.reports enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.user_devices enable row level security;
alter table public.user_ip_events enable row level security;
alter table public.risk_flags enable row level security;
alter table public.user_pair_signals enable row level security;

create policy "reporters read their own reports"
  on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.admin_can('resolve_reports')));

create policy "signed-in users file reports"
  on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open');

-- The person reported is never told who reported them.
revoke update, delete on public.reports from anon, authenticated;

create policy "users read their own tickets"
  on public.support_tickets for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('handle_support')));

create policy "users open their own tickets"
  on public.support_tickets for insert to authenticated
  with check (profile_id = (select auth.uid()) and status = 'open');

revoke update, delete on public.support_tickets from anon, authenticated;

create policy "ticket messages follow the ticket"
  on public.support_messages for select to authenticated
  using (
    exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id
        and (t.profile_id = (select auth.uid()) or public.admin_can('handle_support'))
    )
  );

create policy "users reply on their own tickets"
  on public.support_messages for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and not is_staff
    and exists (
      select 1 from public.support_tickets t
      where t.id = ticket_id and t.profile_id = (select auth.uid())
    )
  );

revoke update, delete on public.support_messages from anon, authenticated;

-- Fingerprints, IP history, risk flags and pair signals are never visible to
-- the user they describe: telling someone which signal tripped is telling them
-- how to avoid it next time.
create policy "admins read device history"
  on public.user_devices for select to authenticated
  using ((select public.admin_can('manage_users')));

create policy "admins read IP history"
  on public.user_ip_events for select to authenticated
  using ((select public.admin_can('manage_users')));

create policy "admins read risk flags"
  on public.risk_flags for select to authenticated
  using ((select public.admin_can('manage_users')));

create policy "admins read pair signals"
  on public.user_pair_signals for select to authenticated
  using ((select public.admin_can('manage_users')));

revoke insert, update, delete on public.user_devices from anon, authenticated;
revoke insert, update, delete on public.user_ip_events from anon, authenticated;
revoke insert, update, delete on public.risk_flags from anon, authenticated;
revoke insert, update, delete on public.user_pair_signals from anon, authenticated;
