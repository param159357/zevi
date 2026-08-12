-- ============================================================================
-- Zevi 0011 — the ledger
--
-- Money on Zevi moves between six places: the gateway, escrow, a worker's
-- payable balance, platform revenue, tax payable, and the chargeback reserve.
-- Every one of those movements is recorded here as a balanced double-entry
-- transaction, and balances are derived by summing entries — never stored as a
-- mutable number somewhere.
--
-- Why this is worth a whole table set on a marketplace whose average job is
-- ₹400: spec §9 says one chargeback wipes out a month at 200 jobs. When that
-- happens you need to say exactly where every rupee of that job went, months
-- after the fact, with a 2% reserve to draw on. A `balance` column that some
-- code path forgot to update cannot answer that.
--
-- Entries are append-only and enforced by trigger, not by convention. A
-- correction is a new, opposite transaction — the same way a real ledger works.
-- ============================================================================

create table public.ledger_accounts (
  id         uuid primary key default gen_random_uuid(),
  type       public.ledger_account_type not null,
  -- Null for platform-level accounts; set for per-worker payable accounts.
  owner_id   uuid references public.profiles (id) on delete restrict,
  code       text not null unique,
  name       text not null,
  currency   char(3) not null default 'INR',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  -- One account per (type, owner). NULLS NOT DISTINCT so the platform-level
  -- accounts are singletons too.
  constraint ledger_accounts_unique unique nulls not distinct (type, owner_id)
);

create index ledger_accounts_owner_idx on public.ledger_accounts (owner_id) where owner_id is not null;
create index ledger_accounts_type_idx on public.ledger_accounts (type);

create table public.ledger_transactions (
  id              uuid primary key default gen_random_uuid(),
  kind            public.ledger_txn_kind not null,
  job_id          uuid references public.jobs (id) on delete restrict,
  -- What caused this: 'payment', 'payout', 'refund', 'penalty', 'chargeback'…
  reference_type  text,
  reference_id    uuid,
  description     text not null,
  -- Webhooks retry. This is what makes replaying one harmless.
  idempotency_key text unique,
  created_by      uuid references public.profiles (id),
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index ledger_transactions_job_idx on public.ledger_transactions (job_id, occurred_at)
  where job_id is not null;
create index ledger_transactions_kind_idx on public.ledger_transactions (kind, occurred_at desc);
create index ledger_transactions_reference_idx
  on public.ledger_transactions (reference_type, reference_id);
create index ledger_transactions_occurred_idx on public.ledger_transactions (occurred_at desc);

create table public.ledger_entries (
  id             bigint generated always as identity primary key,
  transaction_id uuid not null references public.ledger_transactions (id) on delete restrict,
  account_id     uuid not null references public.ledger_accounts (id) on delete restrict,
  direction      public.ledger_direction not null,
  amount_paise   bigint not null check (amount_paise > 0),
  job_id         uuid references public.jobs (id) on delete restrict,
  created_at     timestamptz not null default now()
);

-- Balance queries and account statements.
create index ledger_entries_account_idx on public.ledger_entries (account_id, created_at);
create index ledger_entries_transaction_idx on public.ledger_entries (transaction_id);
create index ledger_entries_job_idx on public.ledger_entries (job_id, created_at) where job_id is not null;

-- ----------------------------------------------------------------------------
-- Append-only, and balanced
-- ----------------------------------------------------------------------------

create trigger ledger_entries_is_append_only
  before update or delete on public.ledger_entries
  for each row execute function public.forbid_mutation();

create trigger ledger_transactions_is_append_only
  before update or delete on public.ledger_transactions
  for each row execute function public.forbid_mutation();

create or replace function public.assert_transaction_balances()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  debits  bigint;
  credits bigint;
begin
  select
    coalesce(sum(amount_paise) filter (where direction = 'debit'), 0),
    coalesce(sum(amount_paise) filter (where direction = 'credit'), 0)
  into debits, credits
  from public.ledger_entries
  where transaction_id = new.transaction_id;

  if debits <> credits then
    raise exception 'ledger transaction % does not balance: % debit vs % credit',
      new.transaction_id, debits, credits
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED: the check runs at COMMIT, once both sides of
-- the transaction have been inserted.
create constraint trigger ledger_entries_balance
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.assert_transaction_balances();

-- ----------------------------------------------------------------------------
-- Derived balances
-- ----------------------------------------------------------------------------

create view public.ledger_account_balances
with (security_invoker = true) as
  select
    a.id as account_id,
    a.code,
    a.type,
    a.owner_id,
    coalesce(sum(e.amount_paise) filter (where e.direction = 'debit'), 0)
      - coalesce(sum(e.amount_paise) filter (where e.direction = 'credit'), 0) as balance_paise,
    count(e.id) as entry_count,
    max(e.created_at) as last_entry_at
  from public.ledger_accounts a
  left join public.ledger_entries e on e.account_id = a.id
  group by a.id, a.code, a.type, a.owner_id;

comment on view public.ledger_account_balances is
  'Debit-positive balance per account. Escrow and worker payable should never go negative.';

-- ============================================================================
-- RLS — nobody reads the ledger through the API except finance admins
-- ============================================================================

alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;

create policy "finance admins read accounts"
  on public.ledger_accounts for select to authenticated
  using ((select public.admin_can('view_finance')));

create policy "finance admins read transactions"
  on public.ledger_transactions for select to authenticated
  using ((select public.admin_can('view_finance')));

create policy "finance admins read entries"
  on public.ledger_entries for select to authenticated
  using ((select public.admin_can('view_finance')));

revoke insert, update, delete on public.ledger_accounts from anon, authenticated;
revoke insert, update, delete on public.ledger_transactions from anon, authenticated;
revoke insert, update, delete on public.ledger_entries from anon, authenticated;
revoke all on public.ledger_account_balances from anon;

-- Per-worker payable account, created on demand by the earnings flow.
create or replace function public.ensure_worker_ledger_account(p_worker_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
begin
  select id into account_id
  from public.ledger_accounts
  where type = 'worker_payable' and owner_id = p_worker_id;

  if account_id is null then
    insert into public.ledger_accounts (type, owner_id, code, name)
    values ('worker_payable', p_worker_id, 'worker_payable:' || p_worker_id, 'Worker payable')
    on conflict (type, owner_id) do nothing
    returning id into account_id;

    if account_id is null then
      select id into account_id
      from public.ledger_accounts
      where type = 'worker_payable' and owner_id = p_worker_id;
    end if;
  end if;

  return account_id;
end;
$$;

revoke execute on function public.ensure_worker_ledger_account(uuid) from public, anon, authenticated;
grant execute on function public.ensure_worker_ledger_account(uuid) to service_role;
