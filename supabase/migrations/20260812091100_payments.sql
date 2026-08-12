-- ============================================================================
-- Zevi 0012 — payments, escrow, refunds, cancellations, chargebacks, documents
--
-- Payment happens at selection, not at posting (spec §4), so a payment row only
-- ever exists for a job someone actually took. Everything charged is broken out
-- into its own column — budget, client commission, GST, gateway fee — because
-- the spec and Indian marketplace rules both require those as separate visible
-- lines, and because a single `amount` column makes a refund unarguable only
-- until the first time someone argues about it.
--
-- job_financials is the frozen snapshot of what the job was priced at: slab,
-- rates, discounts, both commission shares, GST, the worker's net. Written once
-- at assignment and never recomputed, so a slab change next quarter cannot
-- retroactively alter what a worker is owed.
-- ============================================================================

create table public.payments (
  id                     uuid primary key default gen_random_uuid(),
  job_id                 uuid not null references public.jobs (id) on delete restrict,
  client_id              uuid not null references public.profiles (id) on delete restrict,
  status                 public.payment_status not null default 'created',
  -- What the client is actually charged: budget + client commission + GST.
  amount_paise           bigint not null check (amount_paise > 0),
  job_budget_paise       bigint not null check (job_budget_paise >= 14900),
  client_commission_paise bigint not null default 0 check (client_commission_paise >= 0),
  client_tax_paise       bigint not null default 0 check (client_tax_paise >= 0),
  -- Razorpay's cut. Ours to absorb on refunds (spec §14).
  gateway_fee_paise      bigint not null default 0 check (gateway_fee_paise >= 0),
  gateway_tax_paise      bigint not null default 0 check (gateway_tax_paise >= 0),
  razorpay_order_id      text unique,
  razorpay_payment_id    text unique,
  method                 text,
  captured_at            timestamptz,
  failed_at              timestamptz,
  failure_reason         text,
  refunded_paise         bigint not null default 0 check (refunded_paise >= 0),
  payer_ip               inet,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint payments_refund_within_amount check (refunded_paise <= amount_paise)
);

create index payments_job_idx on public.payments (job_id, created_at desc);
create index payments_client_idx on public.payments (client_id, created_at desc);
create index payments_status_idx on public.payments (status, created_at desc);
create index payments_captured_idx on public.payments (captured_at) where captured_at is not null;
-- Stuck-payment sweep: authorised but never captured.
create index payments_pending_idx on public.payments (created_at)
  where status in ('created', 'authorized');

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- The assignment can now point at the payment that funded it.
alter table public.job_assignments
  add constraint job_assignments_payment_fk
  foreign key (payment_id) references public.payments (id) on delete restrict;

-- ----------------------------------------------------------------------------
-- job_financials — the frozen price of one job
-- ----------------------------------------------------------------------------

create table public.job_financials (
  job_id                    uuid primary key references public.jobs (id) on delete restrict,
  slab_id                   uuid not null references public.commission_slabs (id) on delete restrict,
  tax_rate_id               uuid references public.tax_rates (id) on delete restrict,
  budget_paise              bigint not null check (budget_paise >= 14900),
  client_commission_bps     integer not null check (client_commission_bps >= 0),
  worker_commission_bps     integer not null check (worker_commission_bps >= 0),
  client_commission_paise   bigint not null check (client_commission_paise >= 0),
  worker_commission_paise   bigint not null check (worker_commission_paise >= 0),
  tax_rate_bps              integer not null default 0 check (tax_rate_bps >= 0),
  client_tax_paise          bigint not null default 0 check (client_tax_paise >= 0),
  worker_tax_paise          bigint not null default 0 check (worker_tax_paise >= 0),
  -- Loyalty + subscription, capped at 2% by the calculator before it lands here.
  discount_bps              integer not null default 0 check (discount_bps between 0 and 200),
  discount_source           text,
  -- True when the ₹25 floor bit after discounts were applied.
  floor_applied             boolean not null default false,
  cap_applied               boolean not null default false,
  client_total_paise        bigint not null check (client_total_paise > 0),
  worker_net_paise          bigint not null check (worker_net_paise >= 0),
  platform_gross_paise      bigint not null check (platform_gross_paise >= 0),
  computed_at               timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index job_financials_slab_idx on public.job_financials (slab_id);
create index job_financials_computed_idx on public.job_financials (computed_at desc);

-- Frozen once written. A repricing is a cancellation and a new job.
create trigger job_financials_is_append_only
  before update or delete on public.job_financials
  for each row execute function public.forbid_mutation();

-- ----------------------------------------------------------------------------
-- Escrow
-- ----------------------------------------------------------------------------

create table public.escrow_holds (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.jobs (id) on delete restrict,
  payment_id     uuid not null references public.payments (id) on delete restrict,
  amount_paise   bigint not null check (amount_paise > 0),
  status         public.escrow_status not null default 'held',
  -- Money freezes the moment a dispute opens (spec §11).
  frozen_at      timestamptz,
  frozen_reason  text,
  released_at    timestamptz,
  released_paise bigint not null default 0 check (released_paise >= 0),
  refunded_paise bigint not null default 0 check (refunded_paise >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint escrow_holds_split_within_amount check (released_paise + refunded_paise <= amount_paise)
);

create unique index escrow_holds_one_live_idx on public.escrow_holds (job_id)
  where status in ('held', 'frozen');
create index escrow_holds_status_idx on public.escrow_holds (status, created_at);
create index escrow_holds_frozen_idx on public.escrow_holds (frozen_at) where status = 'frozen';
create index escrow_holds_payment_idx on public.escrow_holds (payment_id);

create trigger escrow_holds_set_updated_at
  before update on public.escrow_holds
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Cancellations (spec §5 tiers)
-- ----------------------------------------------------------------------------

create table public.cancellations (
  id                       uuid primary key default gen_random_uuid(),
  job_id                   uuid not null unique references public.jobs (id) on delete restrict,
  cancelled_by             uuid references public.profiles (id) on delete restrict,
  actor_role               public.party_role not null,
  tier                     public.cancellation_tier not null,
  -- How far into the deadline the job was, in basis points. Stored because the
  -- tier boundaries may move and the raw fact should not.
  elapsed_bps              integer check (elapsed_bps between 0 and 10000),
  reason                   text not null check (char_length(reason) >= 3),
  client_refund_paise      bigint not null default 0 check (client_refund_paise >= 0),
  worker_compensation_paise bigint not null default 0 check (worker_compensation_paise >= 0),
  -- ₹15 flat. Never charged when nobody opted in — that failure is ours.
  fee_paise                bigint not null default 0 check (fee_paise >= 0),
  admin_assessed           boolean not null default false,
  assessed_by              uuid references public.profiles (id),
  created_at               timestamptz not null default now()
);

create index cancellations_created_idx on public.cancellations (created_at desc);
create index cancellations_tier_idx on public.cancellations (tier, created_at desc);
create index cancellations_actor_idx on public.cancellations (cancelled_by, created_at desc);

-- ----------------------------------------------------------------------------
-- Refunds — every one generates a document with a logged reason (spec §14)
-- ----------------------------------------------------------------------------

create table public.refunds (
  id                       uuid primary key default gen_random_uuid(),
  job_id                   uuid not null references public.jobs (id) on delete restrict,
  payment_id               uuid not null references public.payments (id) on delete restrict,
  cancellation_id          uuid references public.cancellations (id) on delete restrict,
  dispute_id               uuid, -- FK added in 0015
  amount_paise             bigint not null check (amount_paise > 0),
  reason                   public.refund_reason not null,
  note                     text,
  status                   public.refund_status not null default 'pending',
  -- Zevi absorbs the ~2% gateway fee on refunds rather than passing it on.
  gateway_fee_absorbed_paise bigint not null default 0 check (gateway_fee_absorbed_paise >= 0),
  razorpay_refund_id       text unique,
  document_id              uuid, -- FK added below, once documents exists
  initiated_by             uuid references public.profiles (id),
  failure_reason           text,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index refunds_job_idx on public.refunds (job_id, created_at desc);
create index refunds_payment_idx on public.refunds (payment_id);
create index refunds_status_idx on public.refunds (status, created_at);
create index refunds_reason_idx on public.refunds (reason, created_at desc);

create trigger refunds_set_updated_at
  before update on public.refunds
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Chargebacks — the only failure mode that can end the business (spec §10)
-- ----------------------------------------------------------------------------

create table public.chargebacks (
  id                    uuid primary key default gen_random_uuid(),
  payment_id            uuid not null references public.payments (id) on delete restrict,
  job_id                uuid not null references public.jobs (id) on delete restrict,
  razorpay_dispute_id   text unique,
  amount_paise          bigint not null check (amount_paise > 0),
  reason_code           text,
  status                public.chargeback_status not null default 'open',
  opened_at             timestamptz not null default now(),
  evidence_due_at       timestamptz,
  evidence_submitted_at timestamptz,
  resolved_at           timestamptz,
  -- What it actually cost us once the reserve was applied.
  loss_paise            bigint not null default 0 check (loss_paise >= 0),
  internal_note         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- The one queue nobody may miss a deadline on.
create index chargebacks_open_idx on public.chargebacks (evidence_due_at)
  where status in ('open', 'evidence_submitted');
create index chargebacks_job_idx on public.chargebacks (job_id);
create index chargebacks_payment_idx on public.chargebacks (payment_id);
create index chargebacks_status_idx on public.chargebacks (status, opened_at desc);

create trigger chargebacks_set_updated_at
  before update on public.chargebacks
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Documents — receipts, commission invoices, credit notes, payout advices
--
-- Lines, not a total: fees, commission and GST are always shown separately and
-- never folded together.
-- ----------------------------------------------------------------------------

create table public.documents (
  id           uuid primary key default gen_random_uuid(),
  type         public.document_type not null,
  -- Per-series running number: ZEVI/RCP/2026/000123. Legally a document series
  -- must have no gaps, so it is allocated by the issuer, not by a sequence that
  -- burns numbers on rollback.
  number       text not null unique,
  series       text not null,
  job_id       uuid references public.jobs (id) on delete restrict,
  profile_id   uuid not null references public.profiles (id) on delete restrict,
  total_paise  bigint not null check (total_paise >= 0),
  tax_paise    bigint not null default 0 check (tax_paise >= 0),
  file_id      uuid references public.files (id) on delete set null,
  issued_at    timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index documents_profile_idx on public.documents (profile_id, issued_at desc);
create index documents_job_idx on public.documents (job_id) where job_id is not null;
create index documents_type_idx on public.documents (type, issued_at desc);
create index documents_series_idx on public.documents (series, issued_at desc);

create table public.document_lines (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents (id) on delete cascade,
  position      integer not null,
  kind          public.document_line_kind not null,
  label         text not null,
  amount_paise  bigint not null,
  tax_rate_bps  integer check (tax_rate_bps is null or tax_rate_bps >= 0),
  constraint document_lines_position_unique unique (document_id, position)
);

create index document_lines_document_idx on public.document_lines (document_id, position);

alter table public.refunds
  add constraint refunds_document_fk
  foreign key (document_id) references public.documents (id) on delete set null;

-- ============================================================================
-- RLS
--
-- Clients see their own payments, refunds and documents. Nobody writes money
-- rows through the API: every one of these tables is written by webhook
-- handlers and server actions holding the service-role key, inside the same
-- transaction as the matching ledger entries.
-- ============================================================================

alter table public.payments enable row level security;
alter table public.job_financials enable row level security;
alter table public.escrow_holds enable row level security;
alter table public.cancellations enable row level security;
alter table public.refunds enable row level security;
alter table public.chargebacks enable row level security;
alter table public.documents enable row level security;
alter table public.document_lines enable row level security;

create policy "clients read their own payments"
  on public.payments for select to authenticated
  using (client_id = (select auth.uid()) or (select public.admin_can('view_finance')));

-- Both sides see the price breakdown of a job they are on: the client's fee
-- line and the worker's commission line come from the same row.
create policy "participants read the job price"
  on public.job_financials for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.admin_can('view_finance')));

create policy "participants read the escrow state"
  on public.escrow_holds for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.admin_can('view_finance')));

create policy "participants read cancellations"
  on public.cancellations for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.is_admin()));

create policy "participants read refunds"
  on public.refunds for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.admin_can('view_finance')));

create policy "only finance admins read chargebacks"
  on public.chargebacks for select to authenticated
  using ((select public.admin_can('view_finance')));

create policy "users read their own documents"
  on public.documents for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('view_finance')));

create policy "document lines follow the document"
  on public.document_lines for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_id
        and (d.profile_id = (select auth.uid()) or public.admin_can('view_finance'))
    )
  );

revoke insert, update, delete on public.payments from anon, authenticated;
revoke insert, update, delete on public.job_financials from anon, authenticated;
revoke insert, update, delete on public.escrow_holds from anon, authenticated;
revoke insert, update, delete on public.cancellations from anon, authenticated;
revoke insert, update, delete on public.refunds from anon, authenticated;
revoke insert, update, delete on public.chargebacks from anon, authenticated;
revoke insert, update, delete on public.documents from anon, authenticated;
revoke insert, update, delete on public.document_lines from anon, authenticated;
