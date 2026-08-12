-- ============================================================================
-- Zevi 0003a — platform settings
--
-- Numbers the spec expects to move — the ₹5,000 job cap for the first three
-- months, the auto-accept windows, the dwell timer, the reserve percentage —
-- live here rather than in constants, so changing one is an admin action with
-- an audit entry instead of a deploy.
--
-- What does NOT live here: commission slabs, tax rates and fixed fees. Those
-- are versioned tables of their own (0010) because a historical job must stay
-- reconstructible with the numbers that applied on the day it was priced.
-- ============================================================================

create table public.platform_settings (
  key         text primary key check (key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  value       jsonb not null,
  value_type  text not null check (value_type in ('int', 'bool', 'text', 'json')),
  description text not null,
  -- Settings the browser is allowed to read (upload caps, minimum budget).
  -- Anything operational stays server-side.
  is_public   boolean not null default false,
  updated_by  uuid references public.profiles (id),
  updated_at  timestamptz not null default now()
);

create index platform_settings_public_idx on public.platform_settings (key) where is_public;

create trigger platform_settings_set_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();

alter table public.platform_settings enable row level security;

create policy "public settings are readable"
  on public.platform_settings for select to authenticated, anon
  using (is_public);

create policy "admins read every setting"
  on public.platform_settings for select to authenticated
  using ((select public.admin_can('manage_settings')));

revoke insert, update, delete on public.platform_settings from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Typed accessors
--
-- Security definer so triggers and policies can read settings without every
-- caller needing a policy on the table. Each takes a fallback: a missing
-- setting must never be the reason a payout or an opt-in fails.
-- ----------------------------------------------------------------------------

create or replace function public.setting_int(setting_key text, fallback integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value #>> '{}')::integer
                   from public.platform_settings s
                   where s.key = setting_key), fallback);
$$;

create or replace function public.setting_bigint(setting_key text, fallback bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value #>> '{}')::bigint
                   from public.platform_settings s
                   where s.key = setting_key), fallback);
$$;

create or replace function public.setting_bool(setting_key text, fallback boolean)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select (s.value #>> '{}')::boolean
                   from public.platform_settings s
                   where s.key = setting_key), fallback);
$$;

grant execute on function public.setting_int(text, integer) to authenticated;
grant execute on function public.setting_bigint(text, bigint) to authenticated;
grant execute on function public.setting_bool(text, boolean) to authenticated;
