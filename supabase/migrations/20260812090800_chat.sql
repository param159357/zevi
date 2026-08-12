-- ============================================================================
-- Zevi 0009 — chat with contact masking
--
-- The masking rule in spec §10 is "the number renders as [contact hidden] but
-- the message still sends". That means two versions of every message exist, and
-- RLS is row-level, not column-level — so they live in two tables:
--
--   messages      redacted body. Both participants read it.
--   message_raw   original body. Admins only, for disputes and enforcement.
--
-- Storing the original is deliberate. A worker who pastes a phone number gets
-- warning → rating penalty → suspension, and none of that is defensible if the
-- evidence was thrown away at write time.
-- ============================================================================

create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null unique references public.jobs (id) on delete restrict,
  -- Denormalised participants: every message policy tests them, and going back
  -- to jobs for each row makes chat the slowest screen in the product.
  client_id       uuid not null references public.profiles (id) on delete restrict,
  worker_id       uuid not null references public.profiles (id) on delete restrict,
  is_locked       boolean not null default false,
  locked_reason   text,
  last_message_at timestamptz,
  client_read_at  timestamptz,
  worker_read_at  timestamptz,
  message_count   integer not null default 0 check (message_count >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index conversations_client_idx on public.conversations (client_id, last_message_at desc nulls last);
create index conversations_worker_idx on public.conversations (worker_id, last_message_at desc nulls last);
-- "No chat activity" is one of the collusion signals (spec §10).
create index conversations_quiet_idx on public.conversations (message_count) where message_count < 3;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id            uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id     uuid references public.profiles (id) on delete restrict,
  sender_role   public.party_role not null,
  -- What the other side sees. Never the raw text.
  body          text not null check (char_length(body) between 1 and 4000),
  redaction_count integer not null default 0 check (redaction_count >= 0),
  has_attachments boolean not null default false,
  created_at    timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at desc);
create index messages_sender_idx on public.messages (sender_id, created_at desc) where sender_id is not null;
-- Off-platform contact enforcement: who keeps tripping the masker.
create index messages_redacted_idx on public.messages (created_at desc) where redaction_count > 0;

create table public.message_raw (
  message_id uuid primary key references public.messages (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create table public.message_redactions (
  id         uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  -- 'phone' | 'email' | 'url' | 'handle' | 'spelled_digits'
  kind       text not null,
  matched    text not null,
  created_at timestamptz not null default now()
);

create index message_redactions_message_idx on public.message_redactions (message_id);
create index message_redactions_kind_idx on public.message_redactions (kind, created_at desc);

create table public.message_attachments (
  message_id uuid not null references public.messages (id) on delete cascade,
  file_id    uuid not null references public.files (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (message_id, file_id)
);

create index message_attachments_file_idx on public.message_attachments (file_id);

-- Keeps the conversation header current without a second round trip.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.conversations
     set last_message_at = new.created_at,
         message_count   = message_count + 1
   where id = new.conversation_id;
  return null;
end;
$$;

create trigger messages_touch_conversation
  after insert on public.messages
  for each row execute function public.touch_conversation();

-- ============================================================================
-- RLS
-- ============================================================================

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_raw enable row level security;
alter table public.message_redactions enable row level security;
alter table public.message_attachments enable row level security;

create or replace function public.is_conversation_participant(conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conversation
      and (select auth.uid()) in (c.client_id, c.worker_id)
  );
$$;

grant execute on function public.is_conversation_participant(uuid) to authenticated;

create policy "participants read their conversation"
  on public.conversations for select to authenticated
  using ((select auth.uid()) in (client_id, worker_id) or (select public.is_admin()));

create policy "participants read messages"
  on public.messages for select to authenticated
  using ((select public.is_conversation_participant(conversation_id)) or (select public.is_admin()));

-- Messages are written by a server action that redacts first and writes both
-- rows in one transaction. Letting the browser INSERT here would let a client
-- write an unredacted body straight into the readable table.
revoke insert, update, delete on public.messages from anon, authenticated;
revoke all on public.message_raw from anon;
revoke insert, update, delete on public.message_raw from authenticated;

create policy "admins read raw message bodies"
  on public.message_raw for select to authenticated
  using ((select public.admin_can('view_disputes')));

create policy "admins read redaction hits"
  on public.message_redactions for select to authenticated
  using ((select public.admin_can('view_disputes')) or (select public.admin_can('manage_users')));

revoke insert, update, delete on public.message_redactions from anon, authenticated;

create policy "participants read message attachments"
  on public.message_attachments for select to authenticated
  using (
    exists (
      select 1 from public.messages m
      where m.id = message_id
        and (public.is_conversation_participant(m.conversation_id) or public.is_admin())
    )
  );

revoke insert, update, delete on public.message_attachments from anon, authenticated;
revoke insert, update, delete on public.conversations from anon, authenticated;
