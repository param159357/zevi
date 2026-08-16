-- ============================================================================
-- Zevi 0039 — bounces and complaints, heard
--
-- Migration 0017 gave `email_status` the values `bounced` and `complained` and
-- nothing has ever set them. 0037 recorded `provider_message_id` on every sent
-- row and said why in a comment: it is the only handle a bounce notification can
-- be matched back to, against the day something subscribes to the topic SES
-- reports on. This migration is that day.
--
-- ### Why this is not optional
--
-- Everything else in this module is about a user hearing from us. This one is
-- about Amazon continuing to let us speak at all. SES suspends an account over a
-- 5% bounce rate or a 0.1% complaint rate, and both are measured across the
-- account rather than per message — so a hundred addresses that no longer exist,
-- retried politely for ever, take down the receipts, the payout notices and the
-- dispute mail with them. Spec §15's stated failure mode is users never hearing
-- from you, and this is the fastest route to it.
--
-- The obligation is also the other way round. A complaint is a person pressing
-- "this is spam"; continuing to mail them after that is the behaviour the
-- reputation systems exist to punish, and no template on this platform is worth
-- the argument.
--
-- ### The shape
--
--   email_events        every feedback event, append-only, one row per recipient
--   email_suppressions  the addresses nothing may be sent to, and why
--
--   record_email_feedback()      one event applied: the log row, the outbox
--                                row's status, and the suppression if it earns
--                                one — in one transaction
--   release_email_suppression()  the way back, because a suppression with no
--                                way back is a user who can never be reached
--   enqueue_email()              replaced: a suppressed address gets a
--                                `cancelled` row and its notification, not mail
--
-- Both write functions are service-role only, for the reason 0030's delivery
-- functions and 0037's outbox functions are: each moves rows a single statement
-- cannot, and the caller is a webhook holding the service-role key.
--
-- ### What decides a suppression, and what only decides a log row
--
-- A **permanent** bounce is an address that does not exist. A **complaint** is a
-- person who asked us to stop. Both suppress immediately and neither is a
-- judgement call.
--
-- A **transient** bounce is a full mailbox or a greylist, and SES has already
-- retried it for hours before telling us. Suppressing on the first one would
-- cut off a user whose inbox was briefly full, so those are counted instead:
-- `email.transient_bounce_limit` of them inside
-- `email.transient_bounce_window_days` is a pattern rather than an afternoon.
-- `Undetermined` counts with them, because the honest reading of "we could not
-- tell" is "not yet proven permanent".
--
-- A **reject** is SES refusing to send at all — a virus in an attachment, in
-- practice. That is our problem, not the recipient's, so it fails the outbox row
-- and suppresses nobody. A **delivery delay** changes nothing at all and is
-- recorded so that "was it slow or was it us?" has an answer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tunables
--
-- Same division 0037 and 0038 have: the schedule and the batch size are the
-- caller's, the thresholds that decide whether somebody stops receiving email
-- are the database's. These two are read by `record_email_feedback()` at the
-- moment the event arrives, so moving them changes what the *next* bounce does
-- and never re-judges one already recorded.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('email.transient_bounce_limit', '3', 'int',
   'Soft bounces to one address inside the window before it is suppressed.', false),
  ('email.transient_bounce_window_days', '7', 'int',
   'How far back soft bounces to one address are counted.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Enums
--
-- `email_event_type` is only the five events this platform acts on. SES's
-- configuration sets can publish opens, clicks and sends as well, and none of
-- them belong here: spec §15 asks for no tracking pixels and there is nothing to
-- do with a `Send` event that the outbox row does not already say.
-- ----------------------------------------------------------------------------

create type public.email_event_type as enum (
  'bounce', 'complaint', 'delivery', 'delivery_delay', 'reject'
);

create type public.email_suppression_reason as enum (
  'hard_bounce', 'complaint', 'repeated_soft_bounce', 'manual'
);

-- ----------------------------------------------------------------------------
-- email_events
--
-- One row per recipient per event, append-only by trigger. Append-only because
-- this is the evidence behind a suppression: an address that stops receiving
-- platform email has a support conversation attached to it eventually, and
-- "three soft bounces on the 4th, 6th and 9th, diagnostic 4.2.2 mailbox full"
-- is an answer where "suppressed" is not.
--
-- `sns_message_id` is SNS's own envelope id, not SES's. SNS delivers at least
-- once and retries a 500 for days, so the same bounce arrives more than once as
-- a matter of routine — and a redelivery carries the *same* envelope id, which
-- is what makes it the deduplication key. Unique against the recipient rather
-- than alone, because one notification can name several bounced recipients.
--
-- `outbox_id` is nullable and stays that way. SES reports on messages, and a
-- message we can no longer find a row for — sent before this table existed,
-- sent by Supabase Auth's own sender through the same domain — still counts
-- against the same reputation and still suppresses the same address.
-- ----------------------------------------------------------------------------

create table public.email_events (
  id                  uuid primary key default gen_random_uuid(),
  sns_message_id      text not null,
  outbox_id           uuid references public.email_outbox (id) on delete set null,
  -- SES's `mail.messageId`, which is what `mark_email_sent()` stored.
  provider_message_id text not null,
  event_type          public.email_event_type not null,
  recipient           text not null,
  -- 'Permanent' / 'Transient' / 'Undetermined' for a bounce; the complaint
  -- feedback type for a complaint; the delay type for a delay. Null when the
  -- event has no second axis.
  subtype             text,
  diagnostic          text,
  -- The whole notification, so a shape we did not anticipate is still readable
  -- after the fact rather than lost to the columns we thought of.
  payload             jsonb not null default '{}'::jsonb,
  -- When SES says it happened, not when we heard about it.
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  constraint email_events_sns_message_id_recipient_key unique (sns_message_id, recipient)
);

-- The soft-bounce count in `record_email_feedback()`.
create index email_events_recipient_idx on public.email_events (recipient, occurred_at desc);
-- "What happened to this message?" — the reverse of the outbox's own lookup.
create index email_events_message_idx on public.email_events (provider_message_id);
create index email_events_outbox_idx on public.email_events (outbox_id) where outbox_id is not null;
-- The rate Amazon is watching, answerable without a sequential scan.
create index email_events_type_idx on public.email_events (event_type, occurred_at desc);

create trigger email_events_is_append_only
  before update or delete on public.email_events
  for each row execute function public.forbid_mutation();

-- What the feedback lookup joins on. `email_outbox` has never had an index here
-- because until now nothing read the column.
create index email_outbox_provider_message_idx on public.email_outbox (provider_message_id)
  where provider_message_id is not null;

-- ----------------------------------------------------------------------------
-- email_suppressions
--
-- One row per address, ever — a release does not delete it, it stamps
-- `released_at`, and a later bounce revives the same row with its history
-- intact. `event_count` is what turns "this address bounced once and was
-- released" into "this address has bounced four times and been released three",
-- which is the difference between a mistake and a pattern.
--
-- Keyed on the address rather than on the profile because that is what SES
-- reports and what the reputation is measured against. Two accounts sharing a
-- work address are suppressed together, which is correct: the mailbox is what
-- rejected the mail. `profile_id` is recorded when the event can be traced to
-- one, for support, and is never what the lookup uses.
-- ----------------------------------------------------------------------------

create table public.email_suppressions (
  id             uuid primary key default gen_random_uuid(),
  -- Lowercased by every writer. The local part of an address is technically
  -- case-sensitive and no mail provider in India treats it that way; matching
  -- case-sensitively here would mean suppressing A@x.com and then cheerfully
  -- mailing a@x.com.
  email          text not null unique,
  reason         public.email_suppression_reason not null,
  detail         text,
  profile_id     uuid references public.profiles (id) on delete set null,
  event_count    integer not null default 1 check (event_count > 0),
  suppressed_at  timestamptz not null default now(),
  released_at    timestamptz,
  released_by    uuid references public.profiles (id),
  release_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- A release is a decision with a person and a reason behind it, or it is not a
  -- release. Same rule `admin_audit_log.reason` enforces on every other one.
  constraint email_suppressions_release_is_reasoned check (
    released_at is null
    or (released_by is not null and char_length(coalesce(release_reason, '')) >= 3)
  )
);

-- The live list — what `enqueue_email()` consults, and what a console screen
-- will show when there is one.
create index email_suppressions_active_idx on public.email_suppressions (suppressed_at desc)
  where released_at is null;
create index email_suppressions_profile_idx on public.email_suppressions (profile_id)
  where profile_id is not null;

create trigger email_suppressions_set_updated_at
  before update on public.email_suppressions
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- record_email_feedback
--
-- One event, applied. Everything below happens or none of it does, which is the
-- property that matters: a suppression written without the event behind it is a
-- user cut off for no recorded reason, and an event written without the
-- suppression is a bounce we noticed and did nothing about.
--
-- Returns `duplicate` rather than raising when the same SNS envelope arrives
-- twice, because it will. The webhook answers 200 either way — the point of
-- distinguishing them is the log line, not the response.
--
-- Output columns are named so that none of them collides with a column of any
-- table read below: `outbox_id` would have shadowed `email_events.outbox_id`
-- inside this body, which is 0032's bug wearing a different hat.
-- ----------------------------------------------------------------------------

create or replace function public.record_email_feedback(
  p_sns_message_id      text,
  p_provider_message_id text,
  p_event_type          public.email_event_type,
  p_recipient           text,
  p_subtype             text default null,
  p_diagnostic          text default null,
  p_occurred_at         timestamptz default null,
  p_payload             jsonb default '{}'::jsonb
)
returns table (outcome text, email_outbox_id uuid, suppressed boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient   text := lower(btrim(coalesce(p_recipient, '')));
  v_event_id    uuid;
  v_outbox      public.email_outbox%rowtype;
  v_reason      public.email_suppression_reason;
  v_detail      text;
  v_suppressed  boolean := false;
  v_soft_count  integer;
  v_soft_limit  integer;
  v_soft_days   integer;
  v_soft_window interval;
begin
  if v_recipient = '' or p_sns_message_id is null or p_provider_message_id is null then
    return query select 'invalid'::text, null::uuid, false;
    return;
  end if;

  -- The message this event is about, if it is one of ours. Newest first: SES
  -- message ids are unique, but `deliverEmail` returns a `dev-` id when SES is
  -- unconfigured and nothing stops two of those colliding in a development
  -- database.
  select * into v_outbox
  from public.email_outbox e
  where e.provider_message_id = p_provider_message_id
  order by e.sent_at desc nulls last
  limit 1;

  insert into public.email_events as ev (
    sns_message_id, outbox_id, provider_message_id, event_type,
    recipient, subtype, diagnostic, payload, occurred_at
  )
  values (
    p_sns_message_id, v_outbox.id, p_provider_message_id, p_event_type,
    v_recipient, left(p_subtype, 100), left(p_diagnostic, 2000),
    coalesce(p_payload, '{}'::jsonb), coalesce(p_occurred_at, now())
  )
  -- Named rather than inferred, for the reason 0032 gives: an `on conflict`
  -- inference spec is the one place a qualification is not allowed, so a bare
  -- column list there is substituted with the plpgsql variable of that name.
  on conflict on constraint email_events_sns_message_id_recipient_key do nothing
  returning ev.id into v_event_id;

  if v_event_id is null then
    -- SNS redelivered. Nothing below may run twice — `event_count` would count
    -- one bounce as two and a released suppression would be silently reimposed.
    return query select 'duplicate'::text, v_outbox.id, false;
    return;
  end if;

  -- ---------------------------------------------------------------------------
  -- The outbox row's own status.
  --
  -- Guarded on `sent` in every branch. A message can only bounce after it was
  -- sent, so anything else is an event about a row that has already moved on,
  -- and re-stamping it would lose the earlier fact for no gain.
  -- ---------------------------------------------------------------------------

  if v_outbox.id is not null then
    if p_event_type = 'bounce'::public.email_event_type then
      update public.email_outbox e
         set status = 'bounced'::public.email_status,
             error  = left(concat_ws(': ', p_subtype, coalesce(p_diagnostic, 'bounced')), 2000)
       where e.id = v_outbox.id
         and e.status = 'sent'::public.email_status;

    elsif p_event_type = 'complaint'::public.email_event_type then
      update public.email_outbox e
         set status = 'complained'::public.email_status,
             error  = left(concat_ws(': ', 'complaint', p_subtype), 2000)
       where e.id = v_outbox.id
         and e.status = 'sent'::public.email_status;

    elsif p_event_type = 'reject'::public.email_event_type then
      -- SES took the message and then refused to send it. The row says `sent`
      -- and nothing was; `failed` is the truthful status and the reason belongs
      -- with it.
      update public.email_outbox e
         set status = 'failed'::public.email_status,
             error  = left(concat_ws(': ', 'rejected by SES', p_diagnostic), 2000)
       where e.id = v_outbox.id
         and e.status = 'sent'::public.email_status;
    end if;
  end if;

  -- ---------------------------------------------------------------------------
  -- Whether this address stops receiving mail.
  -- ---------------------------------------------------------------------------

  if p_event_type = 'complaint'::public.email_event_type then
    v_reason := 'complaint'::public.email_suppression_reason;
    v_detail := concat_ws(' ', 'Marked as spam', nullif(concat('(', p_subtype, ')'), '()'));

  elsif p_event_type = 'bounce'::public.email_event_type and p_subtype = 'Permanent' then
    v_reason := 'hard_bounce'::public.email_suppression_reason;
    v_detail := coalesce(p_diagnostic, 'Permanent bounce');

  elsif p_event_type = 'bounce'::public.email_event_type then
    -- Transient, or Undetermined, which is counted with it.
    v_soft_limit  := public.setting_int('email.transient_bounce_limit', 3);
    v_soft_days   := public.setting_int('email.transient_bounce_window_days', 7);
    v_soft_window := make_interval(days => v_soft_days);

    -- Counts the row inserted a few lines above, because it is this
    -- transaction's own and therefore visible: with a limit of 3, the third
    -- bounce is the one that suppresses. Every bounce in the window counts, not
    -- only the transient ones — a permanent one took the branch above and
    -- suppressed already, so the distinction cannot arise.
    select count(*) into v_soft_count
    from public.email_events ev2
    where ev2.recipient = v_recipient
      and ev2.event_type = 'bounce'::public.email_event_type
      and ev2.occurred_at > now() - v_soft_window;

    if v_soft_count >= v_soft_limit then
      v_reason := 'repeated_soft_bounce'::public.email_suppression_reason;
      v_detail := format('%s soft bounces in %s days; last: %s',
                         v_soft_count, v_soft_days,
                         coalesce(p_diagnostic, p_subtype, 'no diagnostic'));
    end if;
  end if;

  if v_reason is not null then
    insert into public.email_suppressions as s (email, reason, detail, profile_id, event_count)
    values (v_recipient, v_reason, left(v_detail, 1000), v_outbox.profile_id, 1)
    on conflict on constraint email_suppressions_email_key do update
      set reason         = excluded.reason,
          detail         = excluded.detail,
          profile_id     = coalesce(excluded.profile_id, s.profile_id),
          event_count    = s.event_count + 1,
          -- An address already suppressed keeps the date it first was. One that
          -- had been released is suppressed again, as of now.
          suppressed_at  = case when s.released_at is null then s.suppressed_at else now() end,
          released_at    = null,
          released_by    = null,
          release_reason = null;

    v_suppressed := true;
  end if;

  return query select 'recorded'::text, v_outbox.id, v_suppressed;
end;
$$;

comment on function public.record_email_feedback is
  'Applies one SES bounce/complaint/delivery event: the append-only log row, the '
  'outbox row''s status, and the suppression if it earns one — in one '
  'transaction. Idempotent on the SNS envelope id. service_role only (0039).';

-- ----------------------------------------------------------------------------
-- release_email_suppression
--
-- Ships with the suppression rather than after it, for the reason
-- `cancel_payout_batch()` ships with the payout builder: a state that cannot be
-- left is a trap, and this one traps a person rather than a batch. A worker
-- whose mailbox was full for a fortnight, or whose colleague pressed "spam" on a
-- shared address, otherwise receives nothing from this platform for ever with
-- no record of why and no way out short of a hand-written UPDATE.
--
-- It does **not** clear the events. Those are the evidence and they stay; what a
-- release says is "send to this address again", not "that never happened". A
-- later bounce revives the same row with `event_count` still climbing.
--
-- Permission is looked up from the actor's id rather than through `admin_can()`,
-- for the reason every other decision function does it: under the service-role
-- key `auth.uid()` is null and `admin_can()` would answer false for a super
-- admin. `manage_users`, because this is a decision about reaching a person.
--
-- There is no console screen for this yet, and that is stated rather than
-- implied — see CLAUDE.md. The function is what a screen will call; until then
-- it is what an operator calls, with an audit row either way.
-- ----------------------------------------------------------------------------

create or replace function public.release_email_suppression(
  p_email    text,
  p_admin_id uuid,
  p_reason   text,
  p_ip       inet default null
)
returns table (status text, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email  text := lower(btrim(coalesce(p_email, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_row    public.email_suppressions%rowtype;
begin
  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::text;
    return;
  end if;

  v_reason := left(v_reason, 500);

  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_admin_id
      and au.is_active
      and (r.is_super or 'manage_users' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::text;
    return;
  end if;

  select * into v_row
  from public.email_suppressions s
  where s.email = v_email
  for update;

  if not found then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  if v_row.released_at is not null then
    return query select 'already_released'::text,
                        format('Released on %s.', v_row.released_at::date)::text;
    return;
  end if;

  update public.email_suppressions s
     set released_at    = now(),
         released_by    = p_admin_id,
         release_reason = v_reason
   where s.id = v_row.id;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state, request_ip
  )
  values (
    p_admin_id, 'email_suppression_released', 'email_suppressions', v_row.id, v_reason,
    to_jsonb(v_row),
    jsonb_build_object('released_at', now(), 'released_by', p_admin_id),
    p_ip
  );

  return query select 'released'::text,
                      format('%s will receive platform email again.', v_email)::text;
end;
$$;

comment on function public.release_email_suppression is
  'Lifts a suppression so an address receives platform email again, with an '
  'audit row and the events left intact. `manage_users`. service_role only (0039).';

-- ----------------------------------------------------------------------------
-- enqueue_email, replaced
--
-- The only change is the suppression lookup and what it does, and what it does
-- is the interesting part: a suppressed recipient still gets a row and still
-- gets the in-site notification. The row lands in `cancelled` — a value
-- `email_status` has had since 0017 with nothing to set it — carrying the
-- reason.
--
-- Three things fall out of that, all of which the obvious `return null` would
-- have cost:
--
--   * the dedupe key is still consumed, so the browser and the webhook both
--     settling a payment still produce one outcome rather than one cancelled row
--     each
--   * the notification is still written, so a client whose email address has
--     died still sees on the site that their job was delivered — the email
--     channel is what failed, not the event
--   * `email_outbox` still answers "what would we have sent this person", which
--     is the first question asked when somebody says they hear nothing from us
--
-- The drain is untouched and needs to be: `claim_email_batch()` claims `queued`
-- and stale `sending` rows, and a `cancelled` row is neither.
-- ----------------------------------------------------------------------------

create or replace function public.enqueue_email(
  p_profile_id         uuid,
  p_template           text,
  p_subject            text,
  p_payload            jsonb,
  p_job_id             uuid default null,
  p_dedupe_key         text default null,
  p_scheduled_for      timestamptz default now(),
  p_notification_type  public.notification_type default null,
  p_notification_title text default null,
  p_notification_body  text default null,
  p_action_url         text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email       text;
  v_outbox_id   uuid;
  v_suppression public.email_suppression_reason;
begin
  -- The address is read here rather than passed in, so a caller cannot send one
  -- user's job to another user's inbox by getting an argument wrong. DPDP
  -- erasure anonymises a profile instead of deleting it (0002), and the
  -- anonymised address belongs to nobody — so there is nothing to send to.
  select p.email into v_email
  from public.profiles p
  where p.id = p_profile_id
    and p.anonymised_at is null;

  if v_email is null then
    return null;
  end if;

  -- Suppressed addresses (0039). Lowercased on both sides: the list is stored
  -- that way and `profiles.email` is stored however it was typed.
  select s.reason into v_suppression
  from public.email_suppressions s
  where s.email = lower(v_email)
    and s.released_at is null;

  insert into public.email_outbox as o (
    profile_id, to_email, template, subject, payload, job_id,
    scheduled_for, dedupe_key, status, error
  )
  values (
    p_profile_id, v_email, p_template, p_subject, coalesce(p_payload, '{}'::jsonb), p_job_id,
    coalesce(p_scheduled_for, now()), p_dedupe_key,
    case
      when v_suppression is null then 'queued'::public.email_status
      else 'cancelled'::public.email_status
    end,
    case
      when v_suppression is null then null
      else 'not sent: ' || v_suppression::text
    end
  )
  -- Named rather than inferred: an `on conflict (col)` inference spec is the one
  -- place a qualification is not allowed and a plpgsql variable would be
  -- substituted instead — the bug migration 0032 is about.
  on conflict on constraint email_outbox_dedupe_key_key do nothing
  returning o.id into v_outbox_id;

  -- Deduplicated: this event has already been queued, so the notification for
  -- it has already been written too. Both or neither.
  if v_outbox_id is null then
    return null;
  end if;

  if p_notification_type is not null and p_notification_title is not null then
    insert into public.notifications (profile_id, type, title, body, job_id, action_url)
    values (
      p_profile_id, p_notification_type, p_notification_title,
      p_notification_body, p_job_id, p_action_url
    );
  end if;

  return v_outbox_id;
end;
$$;

-- ============================================================================
-- RLS and grants
--
-- Both tables follow `email_outbox` exactly (0017): RLS on, every privilege
-- revoked from `anon` and `authenticated`, and no policies at all. They are
-- infrastructure — a send queue, a feedback log and a do-not-mail list — and
-- nothing in a browser session has any business in them. The suppression list
-- in particular is a set of addresses that have complained about us, which is
-- not a thing to hand to a signed-in user.
--
-- When the console grows a screen for this, it gets a `manage_users` select
-- policy on both, the way 0035 widened `escrow_holds` for the dispute screen —
-- not a service-role read inside a query module.
-- ============================================================================

alter table public.email_events enable row level security;
alter table public.email_suppressions enable row level security;

revoke all on public.email_events from anon, authenticated;
revoke all on public.email_suppressions from anon, authenticated;

revoke execute on function public.record_email_feedback(
  text, text, public.email_event_type, text, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_email_feedback(
  text, text, public.email_event_type, text, text, text, timestamptz, jsonb
) to service_role;

revoke execute on function public.release_email_suppression(text, uuid, text, inet)
  from public, anon, authenticated;
grant execute on function public.release_email_suppression(text, uuid, text, inet)
  to service_role;

-- `enqueue_email` was already service-role only (0037) and a `create or replace`
-- keeps the privileges of the function it replaces. Restated anyway, because the
-- day someone drops and recreates it instead is the day any signed-in user can
-- send Zevi-branded mail to any address they can name a profile for.
revoke execute on function public.enqueue_email(
  uuid, text, text, jsonb, uuid, text, timestamptz,
  public.notification_type, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_email(
  uuid, text, text, jsonb, uuid, text, timestamptz,
  public.notification_type, text, text, text
) to service_role;
