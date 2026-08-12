-- ============================================================================
-- Zevi 0013 — earnings, payout batches, payouts
--
-- Twice weekly: the cycle closes Wednesday midnight and pays Friday, closes
-- Sunday midnight and pays Tuesday (spec §6). Eligibility is acceptance plus 48
-- hours before the cutoff; anything short rolls into the next cycle. Both the
-- cutoff and the eligibility stamp are stored on the row, in UTC, computed from
-- Asia/Kolkata wall-clock at the time — never re-derived at read time, because
-- a worker who was told "Friday" must be paid Friday even if the rule changes.
--
-- Three separate reasons money can sit still, kept as three separate columns so
-- the worker's dashboard can say which one applies:
--   eligible_at      the 48-hour maturity after acceptance
--   hold_until       new-client chargeback hold, 14 days on their first 3 jobs
--   status='frozen'  a dispute or a chargeback investigation
-- ============================================================================

create table public.worker_earnings (
  id                 uuid primary key default gen_random_uuid(),
  job_id             uuid not null unique references public.jobs (id) on delete restrict,
  worker_id          uuid not null references public.worker_profiles (profile_id) on delete restrict,
  status             public.earning_status not null default 'pending',
  gross_paise        bigint not null check (gross_paise >= 0),
  commission_paise   bigint not null default 0 check (commission_paise >= 0),
  tax_paise          bigint not null default 0 check (tax_paise >= 0),
  -- Penalties applied against this job's earning (spec §6): up to ₹50 off the
  -- next completed job, 12% off pending earnings.
  penalty_paise      bigint not null default 0 check (penalty_paise >= 0),
  net_paise          bigint not null check (net_paise >= 0),
  accepted_at        timestamptz,
  -- accepted_at + 48h.
  eligible_at        timestamptz,
  hold_until         timestamptz,
  hold_reason        text,
  frozen_reason      text,
  payout_id          uuid, -- FK added below, once payouts exists
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint worker_earnings_net_is_consistent check (
    net_paise <= gross_paise
  )
);

-- The batch builder: confirmed earnings that have matured and are not held.
create index worker_earnings_payable_idx on public.worker_earnings (eligible_at)
  where status = 'confirmed';
create index worker_earnings_hold_idx on public.worker_earnings (hold_until)
  where status = 'on_hold';
-- The worker's earnings dashboard: pending → confirmed → paid.
create index worker_earnings_worker_idx on public.worker_earnings (worker_id, status, created_at desc);
create index worker_earnings_payout_idx on public.worker_earnings (payout_id) where payout_id is not null;
create index worker_earnings_frozen_idx on public.worker_earnings (worker_id) where status = 'frozen';

create trigger worker_earnings_set_updated_at
  before update on public.worker_earnings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Batches
-- ----------------------------------------------------------------------------

create table public.payout_batches (
  id                uuid primary key default gen_random_uuid(),
  cycle_start_at    timestamptz not null,
  -- Wednesday or Sunday midnight IST, stored as the UTC instant it was.
  cutoff_at         timestamptz not null unique,
  scheduled_pay_at  timestamptz not null,
  status            public.payout_batch_status not null default 'open',
  total_paise       bigint not null default 0 check (total_paise >= 0),
  item_count        integer not null default 0 check (item_count >= 0),
  -- Batch review before each run (spec §7).
  reviewed_by       uuid references public.profiles (id),
  reviewed_at       timestamptz,
  processed_at      timestamptz,
  failure_note      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint payout_batches_window check (cutoff_at > cycle_start_at and scheduled_pay_at > cutoff_at)
);

create index payout_batches_status_idx on public.payout_batches (status, scheduled_pay_at);
create index payout_batches_pay_date_idx on public.payout_batches (scheduled_pay_at desc);

create trigger payout_batches_set_updated_at
  before update on public.payout_batches
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Payouts
-- ----------------------------------------------------------------------------

create table public.payouts (
  id                 uuid primary key default gen_random_uuid(),
  batch_id           uuid references public.payout_batches (id) on delete restrict,
  worker_id          uuid not null references public.worker_profiles (profile_id) on delete restrict,
  payout_method_id   uuid not null references public.payout_methods (id) on delete restrict,
  amount_paise       bigint not null check (amount_paise > 0),
  status             public.payout_status not null default 'pending',
  is_instant         boolean not null default false,
  instant_fee_paise  bigint not null default 0 check (instant_fee_paise >= 0),
  razorpay_payout_id text unique,
  utr                text,
  attempt            integer not null default 1 check (attempt >= 1),
  failure_code       text,
  failure_reason     text,
  paid_at            timestamptz,
  failed_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One payout per worker per batch: the batch is the unit of payment.
create unique index payouts_one_per_worker_per_batch_idx
  on public.payouts (batch_id, worker_id) where batch_id is not null;
create index payouts_worker_idx on public.payouts (worker_id, created_at desc);
create index payouts_batch_idx on public.payouts (batch_id, status);
create index payouts_status_idx on public.payouts (status, created_at);
-- The failed-payout queue with retry (spec §7 and §14).
create index payouts_failed_idx on public.payouts (failed_at) where status = 'failed';

create trigger payouts_set_updated_at
  before update on public.payouts
  for each row execute function public.set_updated_at();

alter table public.worker_earnings
  add constraint worker_earnings_payout_fk
  foreign key (payout_id) references public.payouts (id) on delete set null;

-- ----------------------------------------------------------------------------
-- Payout lines — the per-job breakdown the worker sees
-- ----------------------------------------------------------------------------

create table public.payout_items (
  id           uuid primary key default gen_random_uuid(),
  payout_id    uuid not null references public.payouts (id) on delete cascade,
  kind         public.payout_item_kind not null,
  earning_id   uuid references public.worker_earnings (id) on delete restrict,
  job_id       uuid references public.jobs (id) on delete restrict,
  adjustment_id uuid, -- FK added in 0015, once worker_adjustments exists
  -- Signed: earnings add, penalties and reversals subtract.
  amount_paise bigint not null,
  label        text not null,
  created_at   timestamptz not null default now(),
  constraint payout_items_earning_present check (kind <> 'earning' or earning_id is not null)
);

create index payout_items_payout_idx on public.payout_items (payout_id);
create index payout_items_earning_idx on public.payout_items (earning_id) where earning_id is not null;
create index payout_items_job_idx on public.payout_items (job_id) where job_id is not null;

-- ----------------------------------------------------------------------------
-- Standing debits
--
-- The ₹15 abandonment debit that blocks new jobs, and anything else owed. It is
-- drawn down across payouts rather than deducted in one go, so `remaining` is
-- the number the gate checks.
-- ----------------------------------------------------------------------------

create table public.worker_adjustments (
  id               uuid primary key default gen_random_uuid(),
  worker_id        uuid not null references public.worker_profiles (profile_id) on delete restrict,
  penalty_id       uuid, -- FK added in 0015
  kind             public.payout_item_kind not null default 'penalty',
  reason           text not null,
  amount_paise     bigint not null check (amount_paise > 0),
  recovered_paise  bigint not null default 0 check (recovered_paise >= 0),
  -- Blocks the worker from taking new jobs until cleared.
  blocks_new_jobs  boolean not null default false,
  settled_at       timestamptz,
  created_by       uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint worker_adjustments_recovery_within_amount check (recovered_paise <= amount_paise)
);

create index worker_adjustments_worker_idx on public.worker_adjustments (worker_id, settled_at nulls first);
create index worker_adjustments_outstanding_idx on public.worker_adjustments (worker_id)
  where settled_at is null;

create trigger worker_adjustments_set_updated_at
  before update on public.worker_adjustments
  for each row execute function public.set_updated_at();

alter table public.payout_items
  add constraint payout_items_adjustment_fk
  foreign key (adjustment_id) references public.worker_adjustments (id) on delete restrict;

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.worker_earnings enable row level security;
alter table public.payout_batches enable row level security;
alter table public.payouts enable row level security;
alter table public.payout_items enable row level security;
alter table public.worker_adjustments enable row level security;

create policy "workers read their own earnings"
  on public.worker_earnings for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('view_finance')));

create policy "workers read their own payouts"
  on public.payouts for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('manage_payouts')));

create policy "payout lines follow the payout"
  on public.payout_items for select to authenticated
  using (
    exists (
      select 1 from public.payouts p
      where p.id = payout_id
        and (p.worker_id = (select auth.uid()) or public.admin_can('manage_payouts'))
    )
  );

create policy "workers read their own adjustments"
  on public.worker_adjustments for select to authenticated
  using (worker_id = (select auth.uid()) or (select public.admin_can('manage_payouts')));

create policy "payout admins read batches"
  on public.payout_batches for select to authenticated
  using ((select public.admin_can('manage_payouts')) or (select public.admin_can('view_finance')));

revoke insert, update, delete on public.worker_earnings from anon, authenticated;
revoke insert, update, delete on public.payout_batches from anon, authenticated;
revoke insert, update, delete on public.payouts from anon, authenticated;
revoke insert, update, delete on public.payout_items from anon, authenticated;
revoke insert, update, delete on public.worker_adjustments from anon, authenticated;
