-- ============================================================================
-- Zevi 0005 — worker applications, samples, KYC, payout destinations
--
-- Two gates, deliberately far apart in time (spec §6):
--   1. sample approval, 24h SLA, before the worker sees the feed
--   2. KYC, before the first payout — not at signup
--
-- Nothing here stores a raw PAN, bank account number or UPI handle. We keep a
-- hash (for duplicate detection and collusion signals) and the last four digits
-- (for the "paying into ••••4471" line). The full value goes to Razorpay at
-- verification time and is never persisted.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Applications — the unit the admin approval queue works through
-- ----------------------------------------------------------------------------

create table public.worker_applications (
  id                    uuid primary key default gen_random_uuid(),
  worker_id             uuid not null references public.worker_profiles (profile_id) on delete cascade,
  attempt               integer not null default 1 check (attempt between 1 and 2),
  status                public.worker_application_status not null default 'draft',
  submitted_at          timestamptz,
  -- 24-hour SLA. The admin queue is ordered by what is closest to breaching.
  sla_due_at            timestamptz,
  reviewed_by           uuid references public.profiles (id),
  reviewed_at           timestamptz,
  decision_reason       text,
  internal_note         text,
  -- Approve-with-flag: watched on first delivery.
  flagged_for_first_job boolean not null default false,
  -- Rejected workers may resubmit once, after seven days.
  resubmit_after        timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint worker_applications_attempt_unique unique (worker_id, attempt),
  constraint worker_applications_submitted_has_sla check (
    status <> 'submitted' or (submitted_at is not null and sla_due_at is not null)
  )
);

-- The approval queue, ordered by what is rotting first.
create index worker_applications_queue_idx on public.worker_applications (sla_due_at)
  where status = 'submitted';
create index worker_applications_worker_idx on public.worker_applications (worker_id, created_at desc);
create index worker_applications_status_idx on public.worker_applications (status, submitted_at desc);
create index worker_applications_reviewer_idx on public.worker_applications (reviewed_by, reviewed_at desc);

create trigger worker_applications_set_updated_at
  before update on public.worker_applications
  for each row execute function public.set_updated_at();

alter table public.worker_applications enable row level security;

create policy "workers read their own applications"
  on public.worker_applications for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('review_workers')));

create policy "workers create their own application"
  on public.worker_applications for insert to authenticated
  with check (worker_id = (select auth.uid()) and status in ('draft', 'submitted'));

create policy "workers edit their own draft"
  on public.worker_applications for update to authenticated
  using (worker_id = (select auth.uid()) and status = 'draft')
  with check (worker_id = (select auth.uid()) and status in ('draft', 'submitted'));

-- ----------------------------------------------------------------------------
-- Samples — 3 minimum, 6 maximum per category
-- ----------------------------------------------------------------------------

create table public.worker_samples (
  id                     uuid primary key default gen_random_uuid(),
  worker_id              uuid not null references public.worker_profiles (profile_id) on delete cascade,
  application_id         uuid references public.worker_applications (id) on delete set null,
  category_id            uuid not null references public.categories (id) on delete restrict,
  file_id                uuid not null references public.files (id) on delete restrict,
  -- One line: what it was, what they did.
  caption                text not null check (char_length(caption) between 5 and 160),
  -- The explicit "did you make this alone?" checkbox. Storing the answer, and
  -- refusing anything but true, is what makes a later plagiarism ban defensible.
  sole_author_confirmed  boolean not null check (sole_author_confirmed),
  status                 public.sample_status not null default 'pending',
  reverse_search_url     text,
  reverse_search_at      timestamptz,
  reviewed_by            uuid references public.profiles (id),
  reviewed_at            timestamptz,
  rejection_reason       text,
  position               integer not null default 0,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index worker_samples_worker_idx on public.worker_samples (worker_id, category_id, position);
create index worker_samples_application_idx on public.worker_samples (application_id);
create index worker_samples_status_idx on public.worker_samples (status, created_at);
create index worker_samples_category_idx on public.worker_samples (category_id)
  where status = 'approved';
create index worker_samples_file_idx on public.worker_samples (file_id);

create trigger worker_samples_set_updated_at
  before update on public.worker_samples
  for each row execute function public.set_updated_at();

-- The floor (3) is a submit-time check: a worker builds up to it. The ceiling
-- is enforced here because it is a hard rule at every moment in between.
create or replace function public.enforce_sample_ceiling()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  ceiling integer;
  used    integer;
begin
  select c.sample_max into ceiling
  from public.categories c where c.id = new.category_id;

  select count(*) into used
  from public.worker_samples s
  where s.worker_id = new.worker_id
    and s.category_id = new.category_id
    and s.status <> 'rejected';

  if used > coalesce(ceiling, 6) then
    raise exception 'at most % samples per category (attempted %)', coalesce(ceiling, 6), used
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create trigger worker_samples_ceiling
  after insert or update of category_id, status on public.worker_samples
  for each row execute function public.enforce_sample_ceiling();

alter table public.worker_samples enable row level security;

create policy "approved samples are public"
  on public.worker_samples for select to authenticated, anon
  using (status = 'approved');

create policy "workers read their own samples"
  on public.worker_samples for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('review_workers')));

create policy "workers manage their own pending samples"
  on public.worker_samples for insert to authenticated
  with check (worker_id = (select auth.uid()) and status = 'pending');

create policy "workers edit their own pending samples"
  on public.worker_samples for update to authenticated
  using (worker_id = (select auth.uid()) and status in ('pending', 'rejected'))
  with check (worker_id = (select auth.uid()));

create policy "workers withdraw their own pending samples"
  on public.worker_samples for delete to authenticated
  using (worker_id = (select auth.uid()) and status = 'pending');

-- ----------------------------------------------------------------------------
-- KYC — before the first payout, not at signup
-- ----------------------------------------------------------------------------

create table public.worker_kyc (
  worker_id              uuid primary key references public.worker_profiles (profile_id) on delete restrict,
  status                 public.kyc_status not null default 'not_started',
  legal_name             text,
  date_of_birth          date,
  pan_last4              text check (pan_last4 is null or pan_last4 ~ '^[0-9A-Z]{4}$'),
  pan_hash               text check (pan_hash is null or pan_hash ~ '^[a-f0-9]{64}$'),
  -- Names returned by the two Razorpay checks, compared automatically.
  penny_drop_name        text,
  pan_registered_name    text,
  name_match_score       numeric(4, 3) check (name_match_score is null or name_match_score between 0 and 1),
  name_match_passed      boolean,
  -- Name mismatch is a hard block with no override (spec §6).
  blocked_reason         text,
  attempts               integer not null default 0 check (attempts >= 0),
  duplicate_pan_flagged  boolean not null default false,
  provider_reference     text,
  verified_at            timestamptz,
  reviewed_by            uuid references public.profiles (id),
  reviewed_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- One PAN per account. Not unique: a duplicate is flagged for a human, not
-- silently rejected, and we still want to find both sides of the collision.
create index worker_kyc_pan_hash_idx on public.worker_kyc (pan_hash) where pan_hash is not null;
create index worker_kyc_status_idx on public.worker_kyc (status, updated_at desc);
-- 3 failed attempts → admin review.
create index worker_kyc_review_queue_idx on public.worker_kyc (updated_at)
  where status in ('verifying', 'rejected') or attempts >= 3;

create trigger worker_kyc_set_updated_at
  before update on public.worker_kyc
  for each row execute function public.set_updated_at();

-- current_date is not immutable, so 18+ cannot be a CHECK constraint.
create or replace function public.enforce_kyc_adult()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.date_of_birth is not null
     and new.date_of_birth > current_date - interval '18 years' then
    raise exception 'workers must be 18 or older' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger worker_kyc_adult_check
  before insert or update of date_of_birth on public.worker_kyc
  for each row execute function public.enforce_kyc_adult();

alter table public.worker_kyc enable row level security;

create policy "workers read their own KYC"
  on public.worker_kyc for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('manage_payouts')));

-- Submission goes through a server action that calls Razorpay; the row is
-- written with the service-role key so verification results cannot be forged.
revoke insert, update, delete on public.worker_kyc from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Payout destinations
-- ----------------------------------------------------------------------------

create table public.payout_methods (
  id                      uuid primary key default gen_random_uuid(),
  worker_id               uuid not null references public.worker_profiles (profile_id) on delete restrict,
  type                    public.payout_method_type not null,
  status                  public.payout_method_status not null default 'unverified',
  is_default              boolean not null default false,
  label                   text,
  bank_name               text,
  ifsc                    text check (ifsc is null or ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_last4           text check (account_last4 is null or account_last4 ~ '^[0-9]{4}$'),
  upi_handle_masked       text,
  -- Hash of the full destination. Two accounts paying into the same place is
  -- one of the strongest collusion signals we have (spec §10).
  destination_hash        text not null check (destination_hash ~ '^[a-f0-9]{64}$'),
  razorpay_fund_account_id text,
  razorpay_contact_id     text,
  verified_at             timestamptz,
  -- 3 consecutive payout failures → account flagged (spec §14).
  consecutive_failures    integer not null default 0 check (consecutive_failures >= 0),
  last_failure_reason     text,
  disabled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint payout_methods_bank_fields check (
    type <> 'bank_account' or (ifsc is not null and account_last4 is not null)
  ),
  constraint payout_methods_upi_fields check (
    type <> 'upi' or upi_handle_masked is not null
  )
);

create unique index payout_methods_one_default_idx
  on public.payout_methods (worker_id) where is_default and disabled_at is null;
create index payout_methods_worker_idx on public.payout_methods (worker_id, status);
-- Collision lookup for the risk score.
create index payout_methods_destination_idx on public.payout_methods (destination_hash);
create index payout_methods_failures_idx on public.payout_methods (consecutive_failures)
  where consecutive_failures > 0;

create trigger payout_methods_set_updated_at
  before update on public.payout_methods
  for each row execute function public.set_updated_at();

alter table public.payout_methods enable row level security;

create policy "workers read their own payout methods"
  on public.payout_methods for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('manage_payouts')));

revoke insert, update, delete on public.payout_methods from anon, authenticated;
