-- ============================================================================
-- Zevi 0015 — penalties and the four-layer dispute system
--
-- V1 handles disputes by hand, so most of what follows sits empty at launch.
-- The shape is here now because the layers are not four features — they are one
-- record with four ways of reaching an outcome, and retrofitting `layer` and
-- `resolution_source` onto a table full of live disputes is exactly the kind of
-- migration the spec warns against.
--
--   layer 1  auto_resolved     no human: nothing delivered, silence past
--                              auto-accept, no files at all, cancellation tiers
--   layer 2  self_settlement   24h structured screen, offer / counter / accept
--   layer 3  admin_review      AI summarises, a human decides
--   layer 4  instant_split     under ₹300, 50/50, one tap each
--
-- Every deadline the spec states on screen — 24h to respond, 48h to first
-- response, 5 days to decision, 48h appeal window — is a stored timestamp, so
-- the admin queue can order by what is closest to breaching rather than by age.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Penalties (spec §6)
-- ----------------------------------------------------------------------------

create table public.penalties (
  id                    uuid primary key default gen_random_uuid(),
  profile_id            uuid not null references public.profiles (id) on delete restrict,
  role                  public.party_role not null,
  job_id                uuid references public.jobs (id) on delete restrict,
  type                  public.penalty_type not null,
  status                public.penalty_status not null default 'active',
  -- The four consequences of abandoning a job, as separate stored numbers so a
  -- worker can be shown exactly what was taken and why.
  rating_delta          numeric(3, 2),
  debit_paise           bigint not null default 0 check (debit_paise >= 0),
  pending_earnings_bps  integer not null default 0 check (pending_earnings_bps between 0 and 10000),
  next_job_cap_paise    bigint not null default 0 check (next_job_cap_paise >= 0),
  reason                text not null check (char_length(reason) >= 3),
  internal_note         text,
  applied_by            uuid references public.profiles (id),
  settled_at            timestamptz,
  reversed_at           timestamptz,
  reversal_reason       text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index penalties_profile_idx on public.penalties (profile_id, created_at desc);
create index penalties_type_idx on public.penalties (type, created_at desc);
create index penalties_active_idx on public.penalties (profile_id) where status = 'active';
create index penalties_job_idx on public.penalties (job_id) where job_id is not null;

create trigger penalties_set_updated_at
  before update on public.penalties
  for each row execute function public.set_updated_at();

alter table public.worker_adjustments
  add constraint worker_adjustments_penalty_fk
  foreign key (penalty_id) references public.penalties (id) on delete restrict;

alter table public.user_sanctions
  add constraint user_sanctions_penalty_fk
  foreign key (penalty_id) references public.penalties (id) on delete restrict;

-- ----------------------------------------------------------------------------
-- Disputes
-- ----------------------------------------------------------------------------

create table public.disputes (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid not null references public.jobs (id) on delete restrict,
  raised_by            uuid not null references public.profiles (id) on delete restrict,
  raised_by_role       public.party_role not null,
  layer                public.dispute_layer not null default 'admin_review',
  status               public.dispute_status not null default 'open',
  reason_summary       text not null check (char_length(reason_summary) between 10 and 500),
  -- Amount in escrow when the dispute opened. Frozen from this moment.
  amount_paise         bigint not null check (amount_paise >= 0),

  -- Deadlines, all shown on screen and all queue-ordering keys.
  opened_at            timestamptz not null default now(),
  response_due_at      timestamptz not null,   -- other side has 24h
  first_response_due_at timestamptz not null,  -- Zevi responds within 48h
  decision_due_at      timestamptz not null,   -- decided within 5 days
  first_responded_at   timestamptz,

  -- Outcome: release · refund · split, and nothing else.
  outcome              public.dispute_outcome,
  split_client_bps     integer check (split_client_bps is null or split_client_bps between 0 and 10000),
  -- Required internal note on every decision (spec §7).
  decision_note        text,
  decided_by           uuid references public.profiles (id),
  decided_at           timestamptz,
  auto_resolved        boolean not null default false,

  -- ₹15, charged to whoever loses; a split splits the fee.
  fee_paise            bigint not null default 0 check (fee_paise >= 0),
  fee_charged_to       public.party_role,
  closed_at            timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint disputes_split_has_share check (
    outcome is distinct from 'split' or split_client_bps is not null
  ),
  constraint disputes_decision_has_note check (
    outcome is null or auto_resolved or char_length(coalesce(decision_note, '')) >= 10
  )
);

-- Only one live dispute per job: a second complaint joins the existing case.
create unique index disputes_one_live_idx on public.disputes (job_id)
  where status not in ('resolved', 'closed');
-- The admin work queue, ordered by what is rotting (spec §7).
create index disputes_queue_idx on public.disputes (decision_due_at)
  where status in ('open', 'awaiting_response', 'admin_review', 'appealed');
create index disputes_first_response_idx on public.disputes (first_response_due_at)
  where first_responded_at is null;
create index disputes_job_idx on public.disputes (job_id, created_at desc);
create index disputes_raised_by_idx on public.disputes (raised_by, created_at desc);
-- Dispute rate per user: the most useful signal in year one.
create index disputes_status_idx on public.disputes (status, opened_at desc);
create index disputes_layer_idx on public.disputes (layer, opened_at desc);

create trigger disputes_set_updated_at
  before update on public.disputes
  for each row execute function public.set_updated_at();

alter table public.refunds
  add constraint refunds_dispute_fk
  foreign key (dispute_id) references public.disputes (id) on delete restrict;

-- ----------------------------------------------------------------------------
-- Statements — 500 characters, required from each side
-- ----------------------------------------------------------------------------

create table public.dispute_statements (
  id          uuid primary key default gen_random_uuid(),
  dispute_id  uuid not null references public.disputes (id) on delete cascade,
  author_id   uuid not null references public.profiles (id) on delete restrict,
  author_role public.party_role not null,
  body        text not null check (char_length(body) between 20 and 500),
  is_appeal   boolean not null default false,
  created_at  timestamptz not null default now()
);

create index dispute_statements_dispute_idx on public.dispute_statements (dispute_id, created_at);
create index dispute_statements_author_idx on public.dispute_statements (author_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Layer 2 — structured self-settlement
-- ----------------------------------------------------------------------------

create table public.dispute_offers (
  id               uuid primary key default gen_random_uuid(),
  dispute_id       uuid not null references public.disputes (id) on delete cascade,
  proposed_by      uuid not null references public.profiles (id) on delete restrict,
  proposer_role    public.party_role not null,
  outcome          public.dispute_outcome not null,
  split_client_bps integer check (split_client_bps is null or split_client_bps between 0 and 10000),
  message          text check (message is null or char_length(message) <= 500),
  status           public.dispute_offer_status not null default 'pending',
  expires_at       timestamptz not null,
  responded_at     timestamptz,
  responded_by     uuid references public.profiles (id),
  created_at       timestamptz not null default now(),
  constraint dispute_offers_split_has_share check (
    outcome is distinct from 'split' or split_client_bps is not null
  )
);

create index dispute_offers_dispute_idx on public.dispute_offers (dispute_id, created_at desc);
create index dispute_offers_pending_idx on public.dispute_offers (expires_at) where status = 'pending';

-- ----------------------------------------------------------------------------
-- Layer 3 — AI summary. It recommends; it never resolves.
-- ----------------------------------------------------------------------------

create table public.dispute_ai_summaries (
  id                   uuid primary key default gen_random_uuid(),
  dispute_id           uuid not null references public.disputes (id) on delete cascade,
  model                text not null,
  summary              text not null,
  recommended_outcome  public.dispute_outcome,
  recommended_split_bps integer check (recommended_split_bps is null or recommended_split_bps between 0 and 10000),
  confidence           numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  prompt_tokens        integer,
  completion_tokens    integer,
  cost_paise           integer check (cost_paise is null or cost_paise >= 0),
  -- Whether the human agreed. The only honest way to find out if layer 3 works.
  followed_by_admin    boolean,
  created_at           timestamptz not null default now()
);

create index dispute_ai_summaries_dispute_idx on public.dispute_ai_summaries (dispute_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Appeals — one, 48 hours, new evidence only
-- ----------------------------------------------------------------------------

create table public.dispute_appeals (
  id             uuid primary key default gen_random_uuid(),
  dispute_id     uuid not null unique references public.disputes (id) on delete cascade,
  filed_by       uuid not null references public.profiles (id) on delete restrict,
  filer_role     public.party_role not null,
  new_evidence   text not null check (char_length(new_evidence) between 20 and 1000),
  window_ends_at timestamptz not null,
  status         public.dispute_status not null default 'appealed',
  outcome        public.dispute_outcome,
  decision_note  text,
  decided_by     uuid references public.profiles (id),
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);

create index dispute_appeals_open_idx on public.dispute_appeals (window_ends_at) where decided_at is null;

create table public.dispute_evidence (
  dispute_id  uuid not null references public.disputes (id) on delete cascade,
  file_id     uuid not null references public.files (id) on delete restrict,
  uploaded_by uuid not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (dispute_id, file_id)
);

create index dispute_evidence_file_idx on public.dispute_evidence (file_id);

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.penalties enable row level security;
alter table public.disputes enable row level security;
alter table public.dispute_statements enable row level security;
alter table public.dispute_offers enable row level security;
alter table public.dispute_ai_summaries enable row level security;
alter table public.dispute_appeals enable row level security;
alter table public.dispute_evidence enable row level security;

create or replace function public.is_dispute_party(dispute uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.disputes d
    join public.jobs j on j.id = d.job_id
    where d.id = dispute
      and (select auth.uid()) in (j.client_id, j.assigned_worker_id)
  );
$$;

grant execute on function public.is_dispute_party(uuid) to authenticated;

create policy "users read penalties against them"
  on public.penalties for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.admin_can('manage_users')));

revoke insert, update, delete on public.penalties from anon, authenticated;

create policy "both sides read the dispute"
  on public.disputes for select to authenticated
  using ((select public.is_job_participant(job_id)) or (select public.admin_can('view_disputes')));

create policy "participants raise a dispute"
  on public.disputes for insert to authenticated
  with check (
    raised_by = (select auth.uid())
    and (select public.is_job_participant(job_id))
    and status = 'open'
    and outcome is null
  );

-- Deciding a dispute moves money, so the decision columns are written by the
-- resolution flow with the service-role key, never by an UPDATE from a session.
revoke update, delete on public.disputes from anon, authenticated;

create policy "both sides read statements"
  on public.dispute_statements for select to authenticated
  using ((select public.is_dispute_party(dispute_id)) or (select public.admin_can('view_disputes')));

create policy "parties write their own statement"
  on public.dispute_statements for insert to authenticated
  with check (author_id = (select auth.uid()) and (select public.is_dispute_party(dispute_id)));

revoke update, delete on public.dispute_statements from anon, authenticated;

create policy "both sides read offers"
  on public.dispute_offers for select to authenticated
  using ((select public.is_dispute_party(dispute_id)) or (select public.admin_can('view_disputes')));

create policy "parties make an offer"
  on public.dispute_offers for insert to authenticated
  with check (
    proposed_by = (select auth.uid())
    and (select public.is_dispute_party(dispute_id))
    and status = 'pending'
  );

create policy "the other party answers an offer"
  on public.dispute_offers for update to authenticated
  using (
    status = 'pending'
    and proposed_by <> (select auth.uid())
    and (select public.is_dispute_party(dispute_id))
  )
  with check (status in ('accepted', 'countered', 'rejected'));

-- The AI summary is an internal decision aid. Showing either party "the model
-- recommends refund" would turn a recommendation into a negotiating position.
create policy "only admins read AI summaries"
  on public.dispute_ai_summaries for select to authenticated
  using ((select public.admin_can('resolve_disputes')));

revoke insert, update, delete on public.dispute_ai_summaries from anon, authenticated;

create policy "both sides read the appeal"
  on public.dispute_appeals for select to authenticated
  using ((select public.is_dispute_party(dispute_id)) or (select public.admin_can('view_disputes')));

create policy "a party files the one appeal"
  on public.dispute_appeals for insert to authenticated
  with check (filed_by = (select auth.uid()) and (select public.is_dispute_party(dispute_id)));

revoke update, delete on public.dispute_appeals from anon, authenticated;

create policy "both sides read evidence"
  on public.dispute_evidence for select to authenticated
  using ((select public.is_dispute_party(dispute_id)) or (select public.admin_can('view_disputes')));

create policy "parties attach their own evidence"
  on public.dispute_evidence for insert to authenticated
  with check (uploaded_by = (select auth.uid()) and (select public.is_dispute_party(dispute_id)));

revoke update, delete on public.dispute_evidence from anon, authenticated;
