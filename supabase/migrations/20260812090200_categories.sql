-- ============================================================================
-- Zevi 0003 — categories, structured briefs, worker↔category links
--
-- Categories are data, not an enum: admins add, rename and retire them from the
-- console (spec §7), and the "Other" queue is explicitly the roadmap for new
-- ones. Retiring a category must never orphan the jobs that used it, so
-- category_status carries 'retired' instead of deleting the row.
--
-- category_brief_fields is the schema-level half of "prevention beats
-- resolution" (spec §11): slide count, video length, dimensions and file format
-- as required, typed fields rather than prose a client and a worker can read
-- two different ways.
-- ============================================================================

create table public.categories (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                text not null,
  description         text,
  status              public.category_status not null default 'active',
  position            integer not null default 0,
  icon                text,
  -- Per-category overrides of the platform defaults. Null = use the setting.
  min_budget_paise    bigint check (min_budget_paise is null or min_budget_paise >= 14900),
  max_upload_bytes    bigint check (max_upload_bytes is null or max_upload_bytes > 0),
  sample_min          integer not null default 3 check (sample_min >= 1),
  sample_max          integer not null default 6 check (sample_max >= sample_min),
  sample_format_note  text,
  -- Visual work gets a watermarked preview; code and documents get view-only
  -- access until acceptance (spec §6).
  requires_watermark  boolean not null default true,
  retired_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index categories_status_position_idx on public.categories (status, position);
create index categories_name_idx on public.categories (name);

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function public.set_updated_at();

alter table public.categories enable row level security;

create policy "live categories are public"
  on public.categories for select to authenticated, anon
  using (status = 'active');

create policy "admins see every category"
  on public.categories for select to authenticated
  using ((select public.admin_can('manage_categories')));

revoke insert, update, delete on public.categories from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Structured brief fields
-- ----------------------------------------------------------------------------

create table public.category_brief_fields (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references public.categories (id) on delete restrict,
  key          text not null check (key ~ '^[a-z0-9_]+$'),
  label        text not null,
  help_text    text,
  type         public.brief_field_type not null,
  is_required  boolean not null default false,
  options      text[] not null default '{}',
  min_value    numeric,
  max_value    numeric,
  unit         text,
  position     integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint category_brief_fields_key_unique unique (category_id, key),
  constraint category_brief_fields_options_present check (
    type not in ('select', 'multi_select') or cardinality(options) > 0
  )
);

create index category_brief_fields_category_idx
  on public.category_brief_fields (category_id, position) where is_active;

create trigger category_brief_fields_set_updated_at
  before update on public.category_brief_fields
  for each row execute function public.set_updated_at();

alter table public.category_brief_fields enable row level security;

create policy "brief fields are public"
  on public.category_brief_fields for select to authenticated, anon
  using (is_active);

create policy "admins see every brief field"
  on public.category_brief_fields for select to authenticated
  using ((select public.admin_can('manage_categories')));

revoke insert, update, delete on public.category_brief_fields from anon, authenticated;

-- ----------------------------------------------------------------------------
-- worker_categories — maximum three per worker (spec §6)
-- ----------------------------------------------------------------------------

create table public.worker_categories (
  worker_id    uuid not null references public.worker_profiles (profile_id) on delete cascade,
  category_id  uuid not null references public.categories (id) on delete restrict,
  is_primary   boolean not null default false,
  created_at   timestamptz not null default now(),
  primary key (worker_id, category_id)
);

-- The job feed reads this the other way round: "which workers watch this
-- category", so index the reverse direction too.
create index worker_categories_category_idx on public.worker_categories (category_id, worker_id);
create unique index worker_categories_one_primary_idx
  on public.worker_categories (worker_id) where is_primary;

create or replace function public.enforce_worker_category_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  category_count integer;
begin
  select count(*) into category_count
  from public.worker_categories
  where worker_id = new.worker_id;

  if category_count > 3 then
    raise exception 'a worker may hold at most 3 categories (attempted %)', category_count
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- AFTER, so the count already includes the row being added.
create trigger worker_categories_limit
  after insert or update on public.worker_categories
  for each row execute function public.enforce_worker_category_limit();

alter table public.worker_categories enable row level security;

create policy "worker categories are public"
  on public.worker_categories for select to authenticated, anon
  using (true);

create policy "workers manage their own categories"
  on public.worker_categories for all to authenticated
  using (worker_id = (select auth.uid()))
  with check (worker_id = (select auth.uid()));

-- Convenience for the feed policy: is this category one the caller works in?
create or replace function public.worker_works_in_category(cat uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.worker_categories wc
    where wc.worker_id = (select auth.uid()) and wc.category_id = cat
  );
$$;

grant execute on function public.worker_works_in_category(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- worker_category_stats
--
-- Ratings are category-specific by design: 4.9 at decks and 3.2 at video must
-- not blend into one 4.1 (spec §6). Every rating aggregate below is per
-- (worker, category); worker_profiles.rating is only the headline number.
-- ----------------------------------------------------------------------------

create table public.worker_category_stats (
  worker_id           uuid not null references public.worker_profiles (profile_id) on delete cascade,
  category_id         uuid not null references public.categories (id) on delete restrict,
  jobs_completed      integer not null default 0 check (jobs_completed >= 0),
  jobs_abandoned      integer not null default 0 check (jobs_abandoned >= 0),
  -- Weighted, recency-biased, converging on the raw mean over ~10 jobs.
  rating              numeric(3, 2) check (rating is null or rating between 1 and 5),
  rating_count        integer not null default 0 check (rating_count >= 0),
  -- Raw mean kept alongside so the weighting can be re-tuned without losing
  -- the underlying signal.
  rating_raw_sum      integer not null default 0,
  on_time_deliveries  integer not null default 0,
  late_deliveries     integer not null default 0,
  last_job_at         timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (worker_id, category_id)
);

-- Shortlist queries: best-rated and most-experienced workers within a category.
create index worker_category_stats_rating_idx
  on public.worker_category_stats (category_id, rating desc nulls last, jobs_completed desc);
create index worker_category_stats_experience_idx
  on public.worker_category_stats (category_id, jobs_completed desc);

create trigger worker_category_stats_set_updated_at
  before update on public.worker_category_stats
  for each row execute function public.set_updated_at();

alter table public.worker_category_stats enable row level security;

create policy "category stats are public"
  on public.worker_category_stats for select to authenticated, anon
  using (true);

revoke insert, update, delete on public.worker_category_stats from anon, authenticated;
