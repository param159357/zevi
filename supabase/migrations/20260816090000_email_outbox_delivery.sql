-- ============================================================================
-- Zevi 0037 — the email outbox, made to move
--
-- Migration 0017 built the table and said what it was for: SES can fail and
-- reminders are scheduled, so a row is queued and picked up rather than sent
-- inline from a request. This migration is the picking up, plus the two writes
-- that put a row there and take it away again.
--
-- Four functions, all service-role only, for the same reason 0030's delivery
-- functions are: each one moves a row the same statement cannot finish, and
-- `email_outbox` has every privilege revoked from `authenticated` already
-- (0017). A browser session has no business in a send queue.
--
--   enqueue_email()      the row, the notification, and the deduplication
--   claim_email_batch()  what the drain sends, locked so two runs cannot both
--   mark_email_sent()    SES took it, with the id a bounce will quote back
--   mark_email_failed()  it did not, and whether that is worth trying again
--
-- Spec §15's warning — "set up SPF and DKIM from day one or half of these land
-- in spam, which on a website-only platform means users never hear from you" —
-- is why `email_outbox_failures_idx` exists and why nothing here ever deletes a
-- row. A queue you cannot audit after the fact cannot tell you that your mail
-- stopped arriving.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tunables
--
-- The retry *schedule* is in TypeScript (`lib/constants/email.ts`), the same
-- division `lib/payouts/cycle.ts` has with `build_payout_batch()`: the caller
-- decides when to try again, the database keeps the invariant that nobody tries
-- for ever. `email.max_attempts` is that invariant, and it is checked below even
-- when the caller asks for a retry.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('email.max_attempts', '5', 'int',
   'Attempts before a queued email is left failed for a human to look at.', false),
  ('email.claim_stale_minutes', '15', 'int',
   'Minutes before a `sending` row is assumed abandoned and claimable again.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- enqueue_email
--
-- One event, two rows: the email and the in-site notification. Together,
-- because migration 0017 said so — "notifications are written by the same
-- server actions that send the emails, and adding a write later means
-- revisiting every one of them" — and because they should agree. An email that
-- went out with no notification behind it is a support conversation about a
-- screen that does not show what the email said.
--
-- Deduplication is `dedupe_key` and the unique index on it, which is what the
-- column was created for: the browser and the Razorpay webhook both settle a
-- payment, in either order, and exactly one receipt may go out. A caller that
-- passes no key is saying this event cannot repeat.
--
-- Returns the outbox row id, or null when nothing was queued — already sent, or
-- an anonymised profile. Null is an ordinary answer here, not a failure: the
-- caller is a money path that must not care.
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
  v_email    text;
  v_outbox_id uuid;
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

  insert into public.email_outbox as o (
    profile_id, to_email, template, subject, payload, job_id,
    scheduled_for, dedupe_key
  )
  values (
    p_profile_id, v_email, p_template, p_subject, coalesce(p_payload, '{}'::jsonb), p_job_id,
    coalesce(p_scheduled_for, now()), p_dedupe_key
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

-- ----------------------------------------------------------------------------
-- claim_email_batch
--
-- `for update skip locked`, so two drains overlapping — a slow run, a manual
-- curl — take different rows instead of queueing behind each other. Same shape
-- as `sweep_auto_accepts()`, and the same reason.
--
-- The attempt is counted *at the claim*, before SES is called, for the reason
-- `open_worker_kyc_attempt()` counts a KYC attempt before spending a rupee on a
-- penny drop: a counter incremented on completion is a counter a crash escapes.
-- A drain that dies mid-send leaves the row `sending`, and after
-- `email.claim_stale_minutes` the next run picks it up again — with its attempt
-- already spent, which bounds how many times a message that kills the sender
-- can be sent.
-- ----------------------------------------------------------------------------

create or replace function public.claim_email_batch(p_limit integer default 25)
returns table (
  id       uuid,
  to_email text,
  template text,
  subject  text,
  payload  jsonb,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale interval := make_interval(mins => public.setting_int('email.claim_stale_minutes', 15));
begin
  -- A CTE rather than `return query update … returning`: the output columns of
  -- a `returns table` are plpgsql variables with the same names as the columns
  -- being returned, and wrapping the write in a CTE the outer SELECT reads
  -- keeps that ambiguity somewhere Postgres resolves rather than somewhere it
  -- guesses. Everything is qualified for the same reason (see 0032).
  return query
  with claimed as (
    update public.email_outbox e
    set status = 'sending'::public.email_status,
        attempts = e.attempts + 1
    where e.id in (
      select due.id
      from public.email_outbox due
      where (due.status = 'queued'::public.email_status and due.scheduled_for <= now())
         or (due.status = 'sending'::public.email_status and due.updated_at < now() - v_stale)
      order by due.scheduled_for
      limit greatest(coalesce(p_limit, 25), 0)
      for update of due skip locked
    )
    returning e.id, e.to_email, e.template, e.subject, e.payload, e.attempts, e.scheduled_for
  )
  select c.id, c.to_email, c.template, c.subject, c.payload, c.attempts
  from claimed c
  order by c.scheduled_for;
end;
$$;

-- ----------------------------------------------------------------------------
-- mark_email_sent
--
-- `provider_message_id` is the only handle a bounce notification can be matched
-- back to a row with, which is why it is recorded even though nothing reads it
-- yet: SES reports bounces and complaints asynchronously to an SNS topic, and
-- nothing in this codebase subscribes to one. The id is the half of that we can
-- record now for free.
-- ----------------------------------------------------------------------------

create or replace function public.mark_email_sent(p_id uuid, p_message_id text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox e
  set status = 'sent'::public.email_status,
      sent_at = now(),
      provider_message_id = p_message_id,
      error = null
  where e.id = p_id;
$$;

-- ----------------------------------------------------------------------------
-- mark_email_failed
--
-- `p_retry_at` null means the caller has decided this is not worth trying
-- again — SES said the message, the identity or the account is wrong, and four
-- more identical refusals would only be four more marks against a sending
-- reputation. A timestamp means it was transient.
--
-- Either way the ceiling wins: past `email.max_attempts` the row is `failed`
-- whatever the caller asked for. That is the same relationship
-- `build_payout_batch()` has with the payout calendar — the schedule is the
-- caller's, the invariant is the database's.
-- ----------------------------------------------------------------------------

create or replace function public.mark_email_failed(
  p_id       uuid,
  p_error    text,
  p_retry_at timestamptz default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
  v_max      integer := public.setting_int('email.max_attempts', 5);
  v_status   public.email_status;
begin
  select e.attempts into v_attempts
  from public.email_outbox e
  where e.id = p_id;

  if v_attempts is null then
    return null;
  end if;

  v_status := case
    when p_retry_at is null or v_attempts >= v_max then 'failed'::public.email_status
    else 'queued'::public.email_status
  end;

  update public.email_outbox e
  set status = v_status,
      error = left(coalesce(p_error, 'unknown'), 2000),
      scheduled_for = case
        when v_status = 'queued'::public.email_status then p_retry_at
        else e.scheduled_for
      end
  where e.id = p_id;

  return v_status::text;
end;
$$;

-- ----------------------------------------------------------------------------
-- Grants
--
-- Service-role only, all four. `authenticated` cannot reach the outbox table
-- and must not reach it through a function either — `enqueue_email` would
-- otherwise let any signed-in user send Zevi-branded mail to any address they
-- can name a profile for.
-- ----------------------------------------------------------------------------

revoke execute on function public.enqueue_email(
  uuid, text, text, jsonb, uuid, text, timestamptz,
  public.notification_type, text, text, text
) from public, anon, authenticated;
grant execute on function public.enqueue_email(
  uuid, text, text, jsonb, uuid, text, timestamptz,
  public.notification_type, text, text, text
) to service_role;

revoke execute on function public.claim_email_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_email_batch(integer) to service_role;

revoke execute on function public.mark_email_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_email_sent(uuid, text) to service_role;

revoke execute on function public.mark_email_failed(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.mark_email_failed(uuid, text, timestamptz) to service_role;
