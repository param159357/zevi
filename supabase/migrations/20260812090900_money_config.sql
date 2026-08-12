-- ============================================================================
-- Zevi 0010 — commission slabs, tax, fixed fees, subscriptions
--
-- Every rate in this file is versioned with an effective window rather than
-- updated in place. A job priced in March must still be explicable in
-- September, including to a CA, and "we changed the slab table" is not an
-- answer. Nothing here is ever UPDATEd to a new rate: you insert a new row and
-- close the old one.
--
-- These tables hold the *numbers*. The arithmetic — floor, cap, discount stack,
-- GST — stays in the single calculator module under lib/constants, so there is
-- exactly one implementation of it. The SQL side offers lookup only.
-- ============================================================================

-- The exclusion constraints below need btree_gist's operator classes, which
-- live in the extensions schema.
set search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Commission slabs (spec §8)
-- ----------------------------------------------------------------------------

create table public.commission_slabs (
  id                    uuid primary key default gen_random_uuid(),
  label                 text not null,
  min_paise             bigint not null check (min_paise >= 0),
  -- Null upper bound = the open-ended top slab.
  max_paise             bigint check (max_paise is null or max_paise >= min_paise),
  total_bps             integer not null check (total_bps between 0 and 10000),
  client_bps            integer not null check (client_bps between 0 and 10000),
  worker_bps            integer not null check (worker_bps between 0 and 10000),
  -- ₹25 floor, applied after all discounts.
  min_commission_paise  bigint not null default 0 check (min_commission_paise >= 0),
  -- ₹1,500 cap on the top slab.
  max_commission_paise  bigint check (max_commission_paise is null or max_commission_paise > 0),
  effective_from        timestamptz not null default now(),
  effective_to          timestamptz,
  created_at            timestamptz not null default now(),
  constraint commission_slabs_split_adds_up check (client_bps + worker_bps = total_bps),
  -- The client always pays the larger share: workers are the scarce side.
  constraint commission_slabs_client_pays_more check (client_bps >= worker_bps),
  constraint commission_slabs_window check (effective_to is null or effective_to > effective_from),
  -- No two slabs may cover the same rupee at the same moment. Without this,
  -- a typo silently double-charges or under-charges a whole band of jobs.
  constraint commission_slabs_no_overlap exclude using gist (
    int8range(min_paise, max_paise, '[]') with &&,
    tstzrange(effective_from, effective_to) with &&
  )
);

create index commission_slabs_lookup_idx on public.commission_slabs (min_paise, effective_from desc);

comment on column public.commission_slabs.min_commission_paise is
  'Floor, applied after discounts. Split across the two sides in the same '
  'client_bps:worker_bps ratio as the slab — at 7:6 a ₹25 floor is ₹13.46 from '
  'the client and ₹11.54 from the worker. Round one side and give the remainder '
  'to the other so the two shares always sum to exactly the floor.';

comment on column public.commission_slabs.max_commission_paise is
  'Cap on total commission before GST. GST is charged on the capped amount.';

alter table public.commission_slabs enable row level security;

create policy "commission slabs are public"
  on public.commission_slabs for select to authenticated, anon
  using (true);

revoke insert, update, delete on public.commission_slabs from anon, authenticated;

-- Lookup only — no arithmetic. The calculator in lib/constants owns the maths.
create or replace function public.slab_for(budget_paise bigint, at_time timestamptz default now())
returns public.commission_slabs
language sql
stable
as $$
  select s.*
  from public.commission_slabs s
  where budget_paise >= s.min_paise
    and (s.max_paise is null or budget_paise <= s.max_paise)
    and s.effective_from <= at_time
    and (s.effective_to is null or s.effective_to > at_time)
  limit 1;
$$;

grant execute on function public.slab_for(bigint, timestamptz) to authenticated;

-- ----------------------------------------------------------------------------
-- Tax
--
-- 18% on commission today, but built as a line item because the rate is a
-- policy decision confirmed with a CA, not a constant (spec §8).
-- ----------------------------------------------------------------------------

create table public.tax_rates (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  rate_bps       integer not null check (rate_bps between 0 and 10000),
  -- What the rate applies to: 'commission', 'subscription', 'fee'.
  applies_to     text not null,
  jurisdiction   text not null default 'IN',
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  constraint tax_rates_window check (effective_to is null or effective_to > effective_from),
  constraint tax_rates_no_overlap exclude using gist (
    code with =,
    tstzrange(effective_from, effective_to) with &&
  )
);

create index tax_rates_lookup_idx on public.tax_rates (code, effective_from desc);

alter table public.tax_rates enable row level security;

create policy "tax rates are public"
  on public.tax_rates for select to authenticated, anon
  using (true);

revoke insert, update, delete on public.tax_rates from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Fixed fees — cancellation ₹15, dispute ₹15, instant payout ₹15
-- ----------------------------------------------------------------------------

create table public.fee_schedule (
  id             uuid primary key default gen_random_uuid(),
  code           text not null,
  name           text not null,
  amount_paise   bigint not null check (amount_paise >= 0),
  -- Threshold below which the fee is waived, if any.
  waived_below_paise bigint check (waived_below_paise is null or waived_below_paise >= 0),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  note           text,
  created_at     timestamptz not null default now(),
  constraint fee_schedule_window check (effective_to is null or effective_to > effective_from),
  constraint fee_schedule_no_overlap exclude using gist (
    code with =,
    tstzrange(effective_from, effective_to) with &&
  )
);

create index fee_schedule_lookup_idx on public.fee_schedule (code, effective_from desc);

alter table public.fee_schedule enable row level security;

create policy "fees are public"
  on public.fee_schedule for select to authenticated, anon
  using (true);

revoke insert, update, delete on public.fee_schedule from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Subscriptions (post-launch, schema now)
--
-- Three rules from spec §8 are encoded rather than remembered:
--   * free users keep full core access  → nothing here gates a core feature
--   * the newest-worker slot is never sellable → no such column exists
--   * discounts cap at 2% total         → CHECK on the discount
-- ----------------------------------------------------------------------------

create table public.subscription_plans (
  id                       uuid primary key default gen_random_uuid(),
  code                     text not null unique,
  name                     text not null,
  audience                 public.plan_audience not null,
  price_paise              bigint not null check (price_paise > 0),
  commission_discount_bps  integer not null default 0 check (commission_discount_bps between 0 and 200),
  unlimited_opt_ins        boolean not null default false,
  opt_in_limit             integer check (opt_in_limit is null or opt_in_limit > 0),
  free_instant_payouts     integer not null default 0 check (free_instant_payouts >= 0),
  guaranteed_shortlist     boolean not null default false,
  featured_placement       boolean not null default false,
  unlimited_rehire         boolean not null default false,
  brief_templates          boolean not null default false,
  priority_disputes        boolean not null default false,
  gst_invoicing            boolean not null default false,
  is_active                boolean not null default true,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index subscription_plans_audience_idx on public.subscription_plans (audience) where is_active;

create trigger subscription_plans_set_updated_at
  before update on public.subscription_plans
  for each row execute function public.set_updated_at();

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  profile_id             uuid not null references public.profiles (id) on delete restrict,
  plan_id                uuid not null references public.subscription_plans (id) on delete restrict,
  status                 public.subscription_status not null default 'active',
  started_at             timestamptz not null default now(),
  current_period_start   timestamptz not null,
  current_period_end     timestamptz not null,
  cancel_at_period_end   boolean not null default false,
  cancelled_at           timestamptz,
  razorpay_subscription_id text unique,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_period check (current_period_end > current_period_start)
);

create unique index subscriptions_one_active_idx
  on public.subscriptions (profile_id) where status in ('active', 'past_due');
create index subscriptions_renewal_idx on public.subscriptions (current_period_end)
  where status = 'active';
create index subscriptions_plan_idx on public.subscriptions (plan_id, status);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;

create policy "plans are public"
  on public.subscription_plans for select to authenticated, anon
  using (is_active);

create policy "subscribers read their own subscription"
  on public.subscriptions for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('view_finance')));

revoke insert, update, delete on public.subscription_plans from anon, authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
