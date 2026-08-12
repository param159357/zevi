-- ============================================================================
-- Zevi 0014 — blind ratings
--
-- Blind means neither side sees the other's rating until both are in (or the
-- window closes). That is enforced by RLS, not by the UI: `revealed_at` is null
-- until the reveal, and the SELECT policy will not return a rating you did not
-- write while it is null. Hiding the number in the component would leave it
-- sitting in the JSON response.
--
-- Ratings are stored per category, and the aggregate that feeds the shortlist
-- is per (worker, category) — a 4.9 at decks and a 3.2 at video must not blend
-- into one 4.1 (spec §6). The weighting itself (start near the platform mean,
-- converge over ~10 jobs, weight the last three months more) is recomputed into
-- worker_category_stats; this table keeps the raw stars forever.
-- ============================================================================

create table public.rating_tags (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  label      text not null,
  direction  public.rating_direction not null,
  sentiment  public.rating_sentiment not null,
  position   integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create index rating_tags_direction_idx on public.rating_tags (direction, position) where is_active;

create table public.ratings (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.jobs (id) on delete restrict,
  rater_id     uuid not null references public.profiles (id) on delete restrict,
  ratee_id     uuid not null references public.profiles (id) on delete restrict,
  direction    public.rating_direction not null,
  category_id  uuid references public.categories (id) on delete restrict,
  stars        smallint not null check (stars between 1 and 5),
  comment      text check (comment is null or char_length(comment) <= 500),
  -- Grace window: a new worker's first three jobs stay off the public record,
  -- but admins see the real score from job one.
  counts_publicly boolean not null default true,
  revealed_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint ratings_one_per_direction unique (job_id, direction),
  constraint ratings_not_self check (rater_id <> ratee_id)
);

-- Profile pages and the shortlist's "highest rated" slot.
create index ratings_ratee_idx on public.ratings (ratee_id, created_at desc);
create index ratings_ratee_category_idx on public.ratings (ratee_id, category_id, created_at desc)
  where counts_publicly;
create index ratings_rater_idx on public.ratings (rater_id, created_at desc);
create index ratings_job_idx on public.ratings (job_id);
-- The reveal sweep, and "who still owes a rating".
create index ratings_unrevealed_idx on public.ratings (created_at) where revealed_at is null;
-- Collusion signal: a pair that only ever gives five stars (spec §10).
create index ratings_stars_idx on public.ratings (ratee_id, stars);

create table public.rating_tag_selections (
  rating_id uuid not null references public.ratings (id) on delete cascade,
  tag_id    uuid not null references public.rating_tags (id) on delete restrict,
  primary key (rating_id, tag_id)
);

create index rating_tag_selections_tag_idx on public.rating_tag_selections (tag_id);

-- Three quick tags, no more.
create or replace function public.enforce_rating_tag_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  used integer;
begin
  select count(*) into used
  from public.rating_tag_selections
  where rating_id = new.rating_id;

  if used > 3 then
    raise exception 'a rating carries at most 3 tags (attempted %)', used
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create trigger rating_tag_selections_limit
  after insert on public.rating_tag_selections
  for each row execute function public.enforce_rating_tag_limit();

-- The reveal: as soon as both sides have rated, both become visible. The cron
-- sweep does the same for jobs where the window expired with only one rating.
create or replace function public.reveal_ratings_when_both_in()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.ratings r where r.job_id = new.job_id) = 2 then
    update public.ratings
       set revealed_at = now()
     where job_id = new.job_id and revealed_at is null;
  end if;
  return null;
end;
$$;

create trigger ratings_reveal
  after insert on public.ratings
  for each row execute function public.reveal_ratings_when_both_in();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.rating_tags enable row level security;
alter table public.ratings enable row level security;
alter table public.rating_tag_selections enable row level security;

create policy "rating tags are public"
  on public.rating_tags for select to authenticated, anon
  using (is_active);

revoke insert, update, delete on public.rating_tags from anon, authenticated;

-- You always see what you wrote. You see what was written about you only after
-- the reveal. Everyone else sees revealed, public-counting ratings.
create policy "ratings are blind until revealed"
  on public.ratings for select to authenticated
  using (
    rater_id = (select auth.uid())
    or (ratee_id = (select auth.uid()) and revealed_at is not null)
    or (revealed_at is not null and counts_publicly)
    or (select public.admin_can('manage_users'))
  );

create policy "revealed public ratings are readable anonymously"
  on public.ratings for select to anon
  using (revealed_at is not null and counts_publicly);

create policy "participants rate the other side"
  on public.ratings for insert to authenticated
  with check (
    rater_id = (select auth.uid())
    and revealed_at is null
    and (select public.is_job_participant(job_id))
    and exists (
      select 1 from public.jobs j
      where j.id = job_id
        and j.status in ('completed', 'cancelled', 'disputed')
        and (
          (direction = 'client_to_worker' and j.client_id = (select auth.uid())
             and ratee_id = j.assigned_worker_id)
          or (direction = 'worker_to_client' and j.assigned_worker_id = (select auth.uid())
             and ratee_id = j.client_id)
        )
    )
  );

-- Ratings are permanent. A wrong one is an admin correction with an audit
-- entry, not an edit.
revoke update, delete on public.ratings from anon, authenticated;

create policy "tag selections follow the rating"
  on public.rating_tag_selections for select to authenticated
  using (
    exists (
      select 1 from public.ratings r
      where r.id = rating_id
        and (
          r.rater_id = (select auth.uid())
          or (r.ratee_id = (select auth.uid()) and r.revealed_at is not null)
          or (r.revealed_at is not null and r.counts_publicly)
          or public.admin_can('manage_users')
        )
    )
  );

create policy "raters tag their own rating"
  on public.rating_tag_selections for insert to authenticated
  with check (
    exists (
      select 1 from public.ratings r
      where r.id = rating_id and r.rater_id = (select auth.uid()) and r.revealed_at is null
    )
  );

revoke update, delete on public.rating_tag_selections from anon, authenticated;
