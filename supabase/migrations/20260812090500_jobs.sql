-- ============================================================================
-- Zevi 0006 — jobs, briefs, moderation, classification, timeline
--
-- The job row is the spine of the product: matching, money, files, chat,
-- ratings and disputes all hang off it. Three rules are enforced here rather
-- than in application code, because each of them costs money when it slips:
--
--   1. minimum budget ₹149                      → CHECK
--   2. deadline capped by job value at posting  → trigger (the cap depends on
--      another column, so no CHECK can express it)
--   3. description and budget freeze at assignment; the deadline may only be
--      extended                                 → trigger
--
-- jobs.status is denormalised from the tables that actually cause the change
-- (assignments, deliveries, disputes). The denormalisation is worth it: the
-- feed, the dashboards and every admin queue filter on it, and a job feed that
-- joins four tables per card will not stay under a second.
-- ============================================================================

-- Deadline caps by value (spec §5). Immutable, so the trigger can trust it.
create or replace function public.max_deadline_days(budget_paise bigint)
returns integer
language sql
immutable
as $$
  select case
    when budget_paise < 200000 then 7    -- under ₹2,000
    when budget_paise < 500000 then 15   -- ₹2,000–4,999
    else 30                              -- ₹5,000+
  end;
$$;

create table public.jobs (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.profiles (id) on delete restrict,
  -- Null only while an "Other" job is awaiting classification.
  category_id             uuid references public.categories (id) on delete restrict,
  posted_as_other         boolean not null default false,
  title                   text not null check (char_length(title) between 5 and 120),
  description             text not null check (char_length(description) between 20 and 5000),
  budget_paise            bigint not null check (budget_paise >= 14900),
  currency                char(3) not null default 'INR',
  status                  public.job_status not null default 'draft',
  deadline_at             timestamptz,
  published_at            timestamptz,
  -- Unassigned jobs expire; files attached to them are deleted immediately.
  expires_at              timestamptz,
  opt_in_count            integer not null default 0 check (opt_in_count >= 0),
  shortlist_generated_at  timestamptz,
  assigned_worker_id      uuid references public.profiles (id) on delete restrict,
  assigned_at             timestamptz,
  -- Rehire: a job addressed to one past worker before it falls through to the
  -- normal shortlist.
  addressed_to_worker_id  uuid references public.profiles (id) on delete set null,
  delivered_at            timestamptz,
  completed_at            timestamptz,
  auto_accepted           boolean not null default false,
  cancelled_at            timestamptz,
  revision_count          integer not null default 0 check (revision_count >= 0),
  requires_manual_review  boolean not null default false,
  -- Captured at post time for the collusion signals in spec §10.
  post_ip                 inet,
  post_device_hash        text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint jobs_deadline_after_publish check (
    deadline_at is null or published_at is null or deadline_at > published_at
  ),
  constraint jobs_published_has_category check (
    status = 'draft' or posted_as_other or category_id is not null
  ),
  constraint jobs_assigned_has_worker check (
    (assigned_worker_id is null) = (assigned_at is null)
  )
);

-- The worker feed: category, open, newest first. Partial, because the feed only
-- ever looks at open jobs and this keeps the index the size of the live board.
create index jobs_feed_idx on public.jobs (category_id, published_at desc)
  where status = 'open';
-- Client dashboard.
create index jobs_client_idx on public.jobs (client_id, status, created_at desc);
-- Worker dashboard / "my active jobs".
create index jobs_worker_idx on public.jobs (assigned_worker_id, status, assigned_at desc)
  where assigned_worker_id is not null;
-- Admin queue: unassigned jobs about to expire.
create index jobs_expiry_idx on public.jobs (expires_at) where status = 'open';
-- Admin queue: assigned work running out of deadline.
create index jobs_deadline_idx on public.jobs (deadline_at)
  where status in ('assigned', 'revision_requested');
create index jobs_status_created_idx on public.jobs (status, created_at desc);
-- Analytics: posted vs completed, GMV, time-to-assignment (spec §7).
create index jobs_published_at_idx on public.jobs (published_at) where published_at is not null;
create index jobs_completed_at_idx on public.jobs (completed_at) where completed_at is not null;
create index jobs_assigned_at_idx on public.jobs (assigned_at) where assigned_at is not null;
-- Manual review of any first job above ₹2,000, and value filters generally.
create index jobs_value_idx on public.jobs (status, budget_paise desc);
create index jobs_manual_review_idx on public.jobs (created_at) where requires_manual_review;
create index jobs_rehire_idx on public.jobs (addressed_to_worker_id, status)
  where addressed_to_worker_id is not null;
create index jobs_post_ip_idx on public.jobs (post_ip) where post_ip is not null;
create index jobs_post_device_idx on public.jobs (post_device_hash) where post_device_hash is not null;

create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- The lock rules
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
  if new.status in ('open', 'pending_moderation') and new.deadline_at is not null then
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

create trigger jobs_enforce_rules
  before insert or update on public.jobs
  for each row execute function public.enforce_job_rules();

-- ----------------------------------------------------------------------------
-- job_events — append-only timeline
--
-- Written by triggers and by server code. It is the narrative an admin reads
-- on a dispute screen and the evidence trail behind a chargeback, so nothing
-- is allowed to rewrite it.
-- ----------------------------------------------------------------------------

create table public.job_events (
  id          bigint generated always as identity primary key,
  job_id      uuid not null references public.jobs (id) on delete restrict,
  actor_id    uuid references public.profiles (id),
  actor_role  public.party_role not null default 'system',
  event_type  text not null,
  from_status public.job_status,
  to_status   public.job_status,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index job_events_job_idx on public.job_events (job_id, created_at);
create index job_events_type_idx on public.job_events (event_type, created_at desc);
create index job_events_actor_idx on public.job_events (actor_id, created_at desc)
  where actor_id is not null;

create trigger job_events_is_append_only
  before update or delete on public.job_events
  for each row execute function public.forbid_mutation();

create or replace function public.log_job_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.job_events (job_id, actor_id, actor_role, event_type, to_status)
    values (new.id, new.client_id, 'client', 'job.created', new.status);
  elsif new.status is distinct from old.status then
    insert into public.job_events (job_id, actor_id, actor_role, event_type, from_status, to_status)
    values (
      new.id,
      (select auth.uid()),
      case when (select auth.uid()) = new.client_id then 'client'
           when (select auth.uid()) = new.assigned_worker_id then 'worker'
           when (select auth.uid()) is null then 'system'
           else 'admin' end,
      'job.status_changed',
      old.status,
      new.status
    );
  end if;
  return null;
end;
$$;

create trigger jobs_log_status_change
  after insert or update of status on public.jobs
  for each row execute function public.log_job_status_change();

-- ----------------------------------------------------------------------------
-- Attachments and structured brief answers
-- ----------------------------------------------------------------------------

create table public.job_attachments (
  job_id     uuid not null references public.jobs (id) on delete cascade,
  file_id    uuid not null references public.files (id) on delete restrict,
  position   integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (job_id, file_id)
);

create index job_attachments_file_idx on public.job_attachments (file_id);

create table public.job_brief_answers (
  job_id        uuid not null references public.jobs (id) on delete cascade,
  field_id      uuid not null references public.category_brief_fields (id) on delete restrict,
  value_text    text,
  value_number  numeric,
  value_bool    boolean,
  value_options text[],
  primary key (job_id, field_id)
);

create index job_brief_answers_field_idx on public.job_brief_answers (field_id);

-- ----------------------------------------------------------------------------
-- Moderation — prohibited work (spec §13) and the ₹2,000 first-job review
-- ----------------------------------------------------------------------------

create table public.job_moderation (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.jobs (id) on delete restrict,
  trigger       public.moderation_trigger not null,
  status        public.moderation_status not null default 'pending',
  reason        public.moderation_reason,
  note          text,
  auto_score    numeric(4, 3),
  matched_terms text[],
  reviewed_by   uuid references public.profiles (id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint job_moderation_rejection_has_reason check (
    status <> 'rejected' or reason is not null
  )
);

create index job_moderation_queue_idx on public.job_moderation (created_at)
  where status in ('pending', 'escalated');
create index job_moderation_job_idx on public.job_moderation (job_id, created_at desc);
create index job_moderation_reason_idx on public.job_moderation (reason, created_at desc)
  where reason is not null;

create trigger job_moderation_set_updated_at
  before update on public.job_moderation
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- "Other" category classification
--
-- V1 sends every "Other" job straight to the admin queue; the AI columns stay
-- null. The table shape is the same either way, so switching classification on
-- is a code change, not a migration.
-- ----------------------------------------------------------------------------

create table public.job_classifications (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references public.jobs (id) on delete restrict,
  status               public.classification_status not null default 'pending',
  model                text,
  suggested_category_id uuid references public.categories (id) on delete set null,
  confidence           numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  prompt_tokens        integer,
  completion_tokens    integer,
  cost_paise           integer check (cost_paise is null or cost_paise >= 0),
  -- Low-confidence cases become the roadmap for new categories (spec §5).
  resolved_category_id uuid references public.categories (id) on delete set null,
  resolved_by          uuid references public.profiles (id),
  resolved_at          timestamptz,
  error                text,
  created_at           timestamptz not null default now()
);

create index job_classifications_queue_idx on public.job_classifications (created_at)
  where status in ('pending', 'low_confidence', 'admin_review');
create index job_classifications_job_idx on public.job_classifications (job_id, created_at desc);
create index job_classifications_suggested_idx
  on public.job_classifications (suggested_category_id, confidence desc)
  where suggested_category_id is not null;

-- ----------------------------------------------------------------------------
-- Rehire invitations
-- ----------------------------------------------------------------------------

create table public.rehire_invitations (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs (id) on delete cascade,
  worker_id    uuid not null references public.worker_profiles (profile_id) on delete cascade,
  status       public.rehire_status not null default 'pending',
  message      text check (message is null or char_length(message) <= 500),
  expires_at   timestamptz not null,
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint rehire_invitations_unique unique (job_id, worker_id)
);

create index rehire_invitations_worker_idx on public.rehire_invitations (worker_id, status, created_at desc);
-- The sweep that drops an unanswered invitation through to the normal shortlist.
create index rehire_invitations_expiry_idx on public.rehire_invitations (expires_at)
  where status = 'pending';

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.job_attachments enable row level security;
alter table public.job_brief_answers enable row level security;
alter table public.job_moderation enable row level security;
alter table public.job_classifications enable row level security;
alter table public.rehire_invitations enable row level security;

-- Participant test, used by this migration and by chat, delivery and disputes.
create or replace function public.is_job_participant(job uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs j
    where j.id = job
      and (j.client_id = (select auth.uid()) or j.assigned_worker_id = (select auth.uid()))
  );
$$;

create or replace function public.is_job_client(job uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.jobs j where j.id = job and j.client_id = (select auth.uid())
  );
$$;

grant execute on function public.is_job_participant(uuid) to authenticated;
grant execute on function public.is_job_client(uuid) to authenticated;

create policy "clients read their own jobs"
  on public.jobs for select to authenticated
  using (client_id = (select auth.uid()));

create policy "assigned workers read their job"
  on public.jobs for select to authenticated
  using (assigned_worker_id = (select auth.uid()));

-- The feed: open jobs, in a category the worker actually works in, and only
-- for a worker who is approved and in good standing.
create policy "approved workers read the open feed"
  on public.jobs for select to authenticated
  using (
    status = 'open'
    and category_id is not null
    and (select public.is_active_worker())
    and public.worker_works_in_category(category_id)
  );

create policy "invited workers read a rehire job"
  on public.jobs for select to authenticated
  using (addressed_to_worker_id = (select auth.uid()));

create policy "admins read every job"
  on public.jobs for select to authenticated
  using ((select public.is_admin()));

create policy "clients create their own jobs"
  on public.jobs for insert to authenticated
  with check (client_id = (select auth.uid()) and status = 'draft');

create policy "clients edit their own unassigned jobs"
  on public.jobs for update to authenticated
  using (client_id = (select auth.uid()) and status in ('draft', 'pending_moderation', 'open'))
  with check (client_id = (select auth.uid()));

-- After assignment the client can still extend the deadline; the trigger is
-- what limits *which* columns may move.
create policy "clients extend the deadline on live jobs"
  on public.jobs for update to authenticated
  using (client_id = (select auth.uid()) and status in ('assigned', 'revision_requested'))
  with check (client_id = (select auth.uid()));

create policy "clients delete their own drafts"
  on public.jobs for delete to authenticated
  using (client_id = (select auth.uid()) and status = 'draft');

create policy "job timeline follows job visibility"
  on public.job_events for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.is_admin()));

revoke insert, update, delete on public.job_events from anon, authenticated;

create policy "attachments follow job visibility"
  on public.job_attachments for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.is_admin()));

create policy "clients attach files to their own jobs"
  on public.job_attachments for insert to authenticated
  with check ((select public.is_job_client(job_id)));

create policy "clients detach files from their own jobs"
  on public.job_attachments for delete to authenticated
  using ((select public.is_job_client(job_id)));

-- Brief answers are part of the brief: anyone who can see the job can see them.
create policy "brief answers follow job visibility"
  on public.job_brief_answers for select to authenticated
  using (
    (select public.is_job_participant(job_id))
    or (select public.is_admin())
    or exists (
      select 1 from public.jobs j
      where j.id = job_id
        and j.status = 'open'
        and j.category_id is not null
        and (select public.is_active_worker())
        and public.worker_works_in_category(j.category_id)
    )
  );

create policy "clients write their own brief answers"
  on public.job_brief_answers for all to authenticated
  using ((select public.is_job_client(job_id)))
  with check ((select public.is_job_client(job_id)));

create policy "admins read moderation records"
  on public.job_moderation for select to authenticated
  using ((select public.admin_can('manage_users')) or (select public.admin_can('manage_categories')));

revoke insert, update, delete on public.job_moderation from anon, authenticated;

create policy "clients see their own classification result"
  on public.job_classifications for select to authenticated
  using ((select public.is_job_client(job_id)) or (select public.admin_can('manage_categories')));

revoke insert, update, delete on public.job_classifications from anon, authenticated;

create policy "rehire invitations are visible to both sides"
  on public.rehire_invitations for select to authenticated
  using (
    worker_id = (select auth.uid())
    or (select public.is_job_client(job_id))
    or (select public.is_admin())
  );

create policy "clients invite past workers"
  on public.rehire_invitations for insert to authenticated
  with check ((select public.is_job_client(job_id)) and status = 'pending');

create policy "workers answer their own invitations"
  on public.rehire_invitations for update to authenticated
  using (worker_id = (select auth.uid()) and status = 'pending')
  with check (worker_id = (select auth.uid()) and status in ('accepted', 'declined'));
