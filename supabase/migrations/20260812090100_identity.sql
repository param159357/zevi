-- ============================================================================
-- Zevi 0002 — identity, roles, and the public/private split
--
-- Privacy boundary, stated once and relied on everywhere else:
--
--   public.profiles          PII. No policy ever exposes a row to another user.
--   public.public_profiles   the projection other users are allowed to see,
--                            maintained by trigger from profiles.
--   public.worker_profiles   public-safe worker stats (rating, jobs, tier)
--   public.worker_state      private worker state (debits, freezes, KYC status)
--   public.client_profiles   public-safe client stats (rating, cancel rate)
--   public.user_private_stats admin-only counters — dispute rate lives here
--                            because spec §5 says it stays admin-only
--
-- Row-level security is row-level, not column-level. Splitting the tables is
-- what makes "cancellation rate is public, dispute rate is not" enforceable in
-- the database rather than in whichever query happens to select the column.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------

create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete restrict,
  email               text not null,
  email_verified_at   timestamptz,
  mobile              text,
  mobile_verified_at  timestamptz,
  -- Full legal name. Workers must match their bank account (spec §6); clients
  -- are shown display_name instead.
  full_name           text not null check (char_length(full_name) between 2 and 120),
  display_name        text check (char_length(display_name) between 2 and 60),
  avatar_file_id      uuid, -- FK added in 0004 once public.files exists
  status              public.account_status not null default 'active',
  status_reason       text,
  suspended_until     timestamptz,
  is_client           boolean not null default false,
  is_worker           boolean not null default false,
  locale              text not null default 'en',
  timezone            text not null default 'Asia/Kolkata',
  signup_ip           inet,
  last_seen_at        timestamptz,
  -- DPDP erasure is done by anonymising this row, never by deleting it: the
  -- financial history hanging off it has to survive a chargeback six months on.
  anonymised_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint profiles_mobile_e164 check (mobile is null or mobile ~ '^\+[1-9][0-9]{7,14}$'),
  constraint profiles_email_shape check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create unique index profiles_email_key on public.profiles (lower(email));
create unique index profiles_mobile_key on public.profiles (mobile) where mobile is not null;
create index profiles_status_idx on public.profiles (status);
create index profiles_created_at_idx on public.profiles (created_at desc);
-- Sweep that lifts expired suspensions.
create index profiles_suspended_until_idx on public.profiles (suspended_until)
  where suspended_until is not null;
create index profiles_signup_ip_idx on public.profiles (signup_ip) where signup_ip is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;

create policy "own profile is readable"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "own profile is editable"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Users may edit presentation, never their own status or verification stamps.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, display_name, avatar_file_id, locale, timezone)
  on public.profiles to authenticated;
revoke insert, delete on public.profiles from anon, authenticated;

-- ----------------------------------------------------------------------------
-- public_profiles — the only identity surface other users can read
-- ----------------------------------------------------------------------------

create table public.public_profiles (
  profile_id     uuid primary key references public.profiles (id) on delete cascade,
  display_name   text not null,
  avatar_file_id uuid,
  member_since   timestamptz not null,
  is_client      boolean not null default false,
  is_worker      boolean not null default false,
  updated_at     timestamptz not null default now()
);

create index public_profiles_member_since_idx on public.public_profiles (member_since desc);

alter table public.public_profiles enable row level security;

create policy "public identities are readable by signed-in users"
  on public.public_profiles for select to authenticated
  using (true);

create policy "public identities are readable anonymously"
  on public.public_profiles for select to anon
  using (true);

revoke insert, update, delete on public.public_profiles from anon, authenticated;

-- Keep the projection in step with profiles. Security definer: the writing
-- user has no privileges on public_profiles at all.
create or replace function public.sync_public_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.public_profiles as pp
    (profile_id, display_name, avatar_file_id, member_since, is_client, is_worker, updated_at)
  values (
    new.id,
    coalesce(new.display_name, split_part(new.full_name, ' ', 1)),
    new.avatar_file_id,
    new.created_at,
    new.is_client,
    new.is_worker,
    now()
  )
  on conflict (profile_id) do update
    set display_name   = excluded.display_name,
        avatar_file_id = excluded.avatar_file_id,
        is_client      = excluded.is_client,
        is_worker      = excluded.is_worker,
        updated_at     = now();
  return new;
end;
$$;

create trigger profiles_sync_public_profile
  after insert or update of display_name, full_name, avatar_file_id, is_client, is_worker
  on public.profiles
  for each row execute function public.sync_public_profile();

-- ----------------------------------------------------------------------------
-- Admin roles
-- ----------------------------------------------------------------------------

create table public.admin_roles (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  description text,
  is_super    boolean not null default false,
  permissions public.admin_permission[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger admin_roles_set_updated_at
  before update on public.admin_roles
  for each row execute function public.set_updated_at();

create table public.admin_users (
  profile_id uuid primary key references public.profiles (id) on delete restrict,
  role_id    uuid not null references public.admin_roles (id) on delete restrict,
  is_active  boolean not null default true,
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles (id),
  revoked_at timestamptz,
  note       text
);

create index admin_users_role_id_idx on public.admin_users (role_id);
create index admin_users_active_idx on public.admin_users (is_active) where is_active;

alter table public.admin_roles enable row level security;
alter table public.admin_users enable row level security;
-- Deliberately no policies: admin membership is granted out of band with the
-- service-role key, never through the API.

-- ----------------------------------------------------------------------------
-- Access helpers
--
-- Security definer so they can read admin_users without every policy that
-- calls them needing a policy on admin_users — and so RLS never recurses.
-- Always call as `(select public.is_admin())` inside a policy: Postgres then
-- evaluates it once per statement instead of once per row.
-- ----------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au
    where au.profile_id = (select auth.uid()) and au.is_active
  );
$$;

create or replace function public.admin_can(perm public.admin_permission)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = (select auth.uid())
      and au.is_active
      and (r.is_super or perm = any (r.permissions))
  );
$$;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_can(public.admin_permission) to authenticated;

-- ----------------------------------------------------------------------------
-- worker_profiles (public-safe) / worker_state (private)
-- ----------------------------------------------------------------------------

create table public.worker_profiles (
  profile_id            uuid primary key references public.profiles (id) on delete restrict,
  status                public.worker_status not null default 'draft',
  tier                  public.worker_tier not null default 'new',
  tier_computed_at      timestamptz,
  headline              text check (char_length(headline) <= 120),
  bio                   text check (char_length(bio) <= 1000),
  approved_at           timestamptz,
  -- Public rating: weighted, recency-biased, converging over ~10 jobs. The raw
  -- arithmetic mean is deliberately not stored — see 0014.
  rating                numeric(3, 2) check (rating is null or rating between 1 and 5),
  rating_job_count      integer not null default 0 check (rating_job_count >= 0),
  jobs_completed        integer not null default 0 check (jobs_completed >= 0),
  -- Denormalised for the opt-in cap check; job_opt_ins is the source of truth.
  active_opt_ins        integer not null default 0 check (active_opt_ins >= 0),
  last_delivered_at     timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index worker_profiles_status_idx on public.worker_profiles (status);
create index worker_profiles_tier_idx on public.worker_profiles (tier);
-- Shortlist "highest rated" slot.
create index worker_profiles_rating_idx on public.worker_profiles (rating desc nulls last)
  where status in ('approved', 'approved_with_flag');
-- Shortlist "newest" slot and the worker-retention metric.
create index worker_profiles_new_idx on public.worker_profiles (created_at desc)
  where status in ('approved', 'approved_with_flag');
create index worker_profiles_jobs_completed_idx on public.worker_profiles (jobs_completed desc);

create trigger worker_profiles_set_updated_at
  before update on public.worker_profiles
  for each row execute function public.set_updated_at();

alter table public.worker_profiles enable row level security;

create policy "approved workers are publicly visible"
  on public.worker_profiles for select to authenticated, anon
  using (status in ('approved', 'approved_with_flag'));

create policy "workers read their own profile"
  on public.worker_profiles for select to authenticated
  using (profile_id = (select auth.uid()));

create policy "admins read every worker profile"
  on public.worker_profiles for select to authenticated
  using ((select public.admin_can('manage_users')) or (select public.admin_can('review_workers')));

create policy "workers create their own profile"
  on public.worker_profiles for insert to authenticated
  with check (profile_id = (select auth.uid()));

create policy "workers edit their own presentation"
  on public.worker_profiles for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

revoke update on public.worker_profiles from anon, authenticated;
grant update (headline, bio) on public.worker_profiles to authenticated;

-- True only for a worker allowed to take work right now. Defined here because
-- a SQL-language function body is validated against existing tables.
create or replace function public.is_active_worker(uid uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.worker_profiles wp
    join public.profiles p on p.id = wp.profile_id
    where wp.profile_id = coalesce(uid, (select auth.uid()))
      and wp.status in ('approved', 'approved_with_flag')
      and p.status = 'active'
  );
$$;

grant execute on function public.is_active_worker(uuid) to authenticated;

create table public.worker_state (
  profile_id                 uuid primary key references public.worker_profiles (profile_id) on delete restrict,
  kyc_status                 public.kyc_status not null default 'not_started',
  -- ₹15 debit that blocks new jobs, plus anything else outstanding (spec §6).
  outstanding_debit_paise    bigint not null default 0 check (outstanding_debit_paise >= 0),
  earnings_frozen            boolean not null default false,
  earnings_frozen_reason     text,
  lifetime_earnings_paise    bigint not null default 0 check (lifetime_earnings_paise >= 0),
  first_payout_at            timestamptz,
  jobs_abandoned             integer not null default 0 check (jobs_abandoned >= 0),
  -- Grace window: the first three jobs' sub-3 ratings stay off the public
  -- record but admins see them from job one (spec §6).
  low_ratings_in_grace       integer not null default 0,
  true_rating                numeric(3, 2),
  -- Newest-slot rotation: a worker occupies the slot for a bounded number of
  -- shortlists or days, then rotates out even if never picked.
  newest_slot_shortlists     integer not null default 0,
  newest_slot_started_at     timestamptz,
  newest_slot_retired_at     timestamptz,
  -- Loyalty (top tier) plus subscription, capped at 2% by the calculator.
  loyalty_discount_bps       integer not null default 0 check (loyalty_discount_bps between 0 and 200),
  opt_in_limit_override      integer check (opt_in_limit_override is null or opt_in_limit_override > 0),
  updated_at                 timestamptz not null default now()
);

create index worker_state_kyc_status_idx on public.worker_state (kyc_status);
create index worker_state_frozen_idx on public.worker_state (earnings_frozen) where earnings_frozen;
create index worker_state_debit_idx on public.worker_state (outstanding_debit_paise)
  where outstanding_debit_paise > 0;
create index worker_state_newest_slot_idx on public.worker_state (newest_slot_started_at)
  where newest_slot_retired_at is null and newest_slot_started_at is not null;

create trigger worker_state_set_updated_at
  before update on public.worker_state
  for each row execute function public.set_updated_at();

alter table public.worker_state enable row level security;

create policy "workers read their own state"
  on public.worker_state for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('manage_users')));

revoke insert, update, delete on public.worker_state from anon, authenticated;

-- Every worker_profiles row gets exactly one worker_state row. Triggers that
-- read the private state (opt-in caps, payout eligibility) can then assume it.
create or replace function public.create_worker_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.worker_state (profile_id) values (new.profile_id)
  on conflict (profile_id) do nothing;

  update public.profiles set is_worker = true where id = new.profile_id and not is_worker;
  return null;
end;
$$;

create trigger worker_profiles_create_state
  after insert on public.worker_profiles
  for each row execute function public.create_worker_state();

-- ----------------------------------------------------------------------------
-- client_profiles
-- ----------------------------------------------------------------------------

create table public.client_profiles (
  profile_id              uuid primary key references public.profiles (id) on delete restrict,
  rating                  numeric(3, 2) check (rating is null or rating between 1 and 5),
  rating_job_count        integer not null default 0 check (rating_job_count >= 0),
  jobs_posted             integer not null default 0 check (jobs_posted >= 0),
  jobs_completed          integer not null default 0 check (jobs_completed >= 0),
  jobs_cancelled          integer not null default 0 check (jobs_cancelled >= 0),
  cancellation_rate_bps   integer not null default 0 check (cancellation_rate_bps between 0 and 10000),
  first_job_at            timestamptz,
  last_job_at             timestamptz,
  total_spend_paise       bigint not null default 0 check (total_spend_paise >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index client_profiles_rating_idx on public.client_profiles (rating desc nulls last);
create index client_profiles_jobs_completed_idx on public.client_profiles (jobs_completed desc);
-- Chargeback rule: worker payout is held for a new client's first three jobs.
create index client_profiles_new_client_idx on public.client_profiles (jobs_completed)
  where jobs_completed < 3;

create trigger client_profiles_set_updated_at
  before update on public.client_profiles
  for each row execute function public.set_updated_at();

alter table public.client_profiles enable row level security;

create policy "client reputation is public"
  on public.client_profiles for select to authenticated, anon
  using (true);

create policy "clients create their own profile"
  on public.client_profiles for insert to authenticated
  with check (profile_id = (select auth.uid()));

revoke update, delete on public.client_profiles from anon, authenticated;

create or replace function public.mark_profile_as_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set is_client = true where id = new.profile_id and not is_client;
  return null;
end;
$$;

create trigger client_profiles_mark_profile
  after insert on public.client_profiles
  for each row execute function public.mark_profile_as_client();

-- ----------------------------------------------------------------------------
-- user_private_stats — admin eyes only
-- ----------------------------------------------------------------------------

create table public.user_private_stats (
  profile_id            uuid primary key references public.profiles (id) on delete restrict,
  disputes_raised       integer not null default 0,
  disputes_against      integer not null default 0,
  disputes_lost         integer not null default 0,
  dispute_rate_bps      integer not null default 0 check (dispute_rate_bps between 0 and 10000),
  chargebacks           integer not null default 0,
  reports_against       integer not null default 0,
  -- Spec §10: a simple additive risk score, no ML. Components kept alongside
  -- the total so the admin screen can show why.
  risk_score            integer not null default 0 check (risk_score between 0 and 100),
  risk_components       jsonb not null default '{}'::jsonb,
  risk_computed_at      timestamptz,
  updated_at            timestamptz not null default now()
);

create index user_private_stats_risk_idx on public.user_private_stats (risk_score desc);
create index user_private_stats_dispute_rate_idx on public.user_private_stats (dispute_rate_bps desc);

create trigger user_private_stats_set_updated_at
  before update on public.user_private_stats
  for each row execute function public.set_updated_at();

alter table public.user_private_stats enable row level security;

create policy "admins read private stats"
  on public.user_private_stats for select to authenticated
  using ((select public.admin_can('manage_users')));

revoke insert, update, delete on public.user_private_stats from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Mobile verification
--
-- Email verification is Supabase Auth's job; mobile is ours (SES sends email
-- only), so the OTP lives here. Hashed, attempt-capped, service-role only.
-- ----------------------------------------------------------------------------

create table public.phone_verifications (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles (id) on delete cascade,
  mobile       text not null,
  otp_hash     text not null,
  attempts     integer not null default 0 check (attempts >= 0),
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  request_ip   inet,
  created_at   timestamptz not null default now()
);

create index phone_verifications_profile_idx on public.phone_verifications (profile_id, created_at desc);
create index phone_verifications_mobile_idx on public.phone_verifications (mobile, created_at desc);
create index phone_verifications_expiry_idx on public.phone_verifications (expires_at)
  where consumed_at is null;

alter table public.phone_verifications enable row level security;
revoke all on public.phone_verifications from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Sanctions: warn · suspend · ban, always with a reason
-- ----------------------------------------------------------------------------

create table public.user_sanctions (
  id             uuid primary key default gen_random_uuid(),
  profile_id     uuid not null references public.profiles (id) on delete restrict,
  type           public.sanction_type not null,
  reason         text not null check (char_length(reason) >= 3),
  internal_note  text,
  issued_by      uuid references public.profiles (id),
  report_id      uuid, -- FK added in 0016 once public.reports exists
  penalty_id     uuid, -- FK added in 0015 once public.penalties exists
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,
  lifted_at      timestamptz,
  lifted_by      uuid references public.profiles (id),
  created_at     timestamptz not null default now()
);

create index user_sanctions_profile_idx on public.user_sanctions (profile_id, created_at desc);
create index user_sanctions_type_idx on public.user_sanctions (type, created_at desc);
create index user_sanctions_active_idx on public.user_sanctions (ends_at)
  where lifted_at is null and ends_at is not null;

alter table public.user_sanctions enable row level security;

create policy "users see sanctions against them"
  on public.user_sanctions for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('manage_users')));

revoke insert, update, delete on public.user_sanctions from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Admin audit log — permanent, no deletes, reason mandatory (spec §7)
-- ----------------------------------------------------------------------------

create table public.admin_audit_log (
  id            bigint generated always as identity primary key,
  admin_id      uuid not null references public.profiles (id),
  action        text not null,
  target_table  text not null,
  target_id     uuid,
  reason        text not null check (char_length(reason) >= 3),
  before_state  jsonb,
  after_state   jsonb,
  request_ip    inet,
  created_at    timestamptz not null default now()
);

create index admin_audit_log_admin_idx on public.admin_audit_log (admin_id, created_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log (target_table, target_id, created_at desc);
create index admin_audit_log_action_idx on public.admin_audit_log (action, created_at desc);
create index admin_audit_log_created_at_idx on public.admin_audit_log (created_at desc);

create trigger admin_audit_log_is_append_only
  before update or delete on public.admin_audit_log
  for each row execute function public.forbid_mutation();

alter table public.admin_audit_log enable row level security;

create policy "audit log is readable by admins with the permission"
  on public.admin_audit_log for select to authenticated
  using ((select public.admin_can('view_audit_log')));

revoke insert, update, delete on public.admin_audit_log from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Signup bridge
--
-- profiles.insert is revoked from every API role, so the row is created here
-- from the auth trigger and nowhere else. One identity per auth user, always.
-- ----------------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, email_verified_at, full_name, signup_ip)
  values (
    new.id,
    new.email,
    new.email_confirmed_at,
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      split_part(new.email, '@', 1)
    ),
    nullif(new.raw_user_meta_data ->> 'signup_ip', '')::inet
  )
  on conflict (id) do nothing;

  insert into public.user_private_stats (profile_id)
  values (new.id)
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
