-- ============================================================================
-- Zevi 0021 — signup and login: email verification sync, mobile OTP
--
-- Spec §5 and §6 both open with the same sentence: email and mobile, both
-- compulsory and verified. Email verification is Supabase Auth's job; this
-- migration mirrors its result into `profiles` so a policy or a report can ask
-- "is this account verified" without reaching into the auth schema.
--
-- Mobile is ours. `phone_verifications` was created in 0002 with no write path
-- at all — deliberately, since nothing could write it safely from the browser.
-- The two functions below are that write path: they run as service_role from a
-- Server Action, and they own the rate limit, the attempt cap and the moment
-- `profiles.mobile_verified_at` is stamped.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tunables
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('auth.otp_length', '6', 'int', 'Digits in a mobile OTP.', true),
  ('auth.otp_ttl_seconds', '600', 'int', 'How long a mobile OTP stays valid.', true),
  ('auth.otp_max_attempts', '5', 'int', 'Wrong guesses before an OTP is burned.', false),
  ('auth.otp_resend_cooldown_seconds', '60', 'int', 'Minimum gap between two OTP sends.', true),
  ('auth.otp_max_sends_per_hour', '5', 'int', 'OTP sends per profile per hour.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Email verification, mirrored from auth.users
--
-- 0002 stamps email_verified_at at signup from `email_confirmed_at`, which is
-- null at that point for every account that has to confirm. This keeps the
-- column true afterwards — on confirmation, and on any later email change.
-- ----------------------------------------------------------------------------

create or replace function public.handle_auth_user_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set email             = coalesce(new.email, email),
         email_verified_at = new.email_confirmed_at
   where id = new.id
     and (email is distinct from coalesce(new.email, email)
       or email_verified_at is distinct from new.email_confirmed_at);

  return new;
end;
$$;

comment on function public.handle_auth_user_updated is
  'Trigger: mirrors auth.users email and confirmation into public.profiles.';

-- Scoped to the two columns so the trigger stays quiet during the sign-in and
-- token-refresh writes GoTrue makes on every request.
create trigger on_auth_user_updated
  after update of email, email_confirmed_at on auth.users
  for each row execute function public.handle_auth_user_updated();

-- ----------------------------------------------------------------------------
-- request_phone_verification
--
-- The caller generates the OTP (it has to — it is the one that can send an
-- SMS) and hands it here to be hashed. bcrypt, not a digest: a six-digit code
-- behind SHA-256 is a rainbow table with a million rows.
--
-- Returns one row. `status` is one of:
--   sent            — code stored, caller should now send the SMS
--   invalid_mobile  — not E.164
--   unknown_profile — no such profile
--   mobile_taken    — verified against a different account
--   cooldown        — too soon after the last send; see retry_after_seconds
--   rate_limited    — hourly ceiling reached; see retry_after_seconds
-- ----------------------------------------------------------------------------

create or replace function public.request_phone_verification(
  p_profile_id  uuid,
  p_mobile      text,
  p_otp         text,
  p_request_ip  inet default null
)
returns table (status text, retry_after_seconds integer, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cooldown   integer := public.setting_int('auth.otp_resend_cooldown_seconds', 60);
  v_max_hourly integer := public.setting_int('auth.otp_max_sends_per_hour', 5);
  v_ttl        integer := public.setting_int('auth.otp_ttl_seconds', 600);
  v_last_sent  timestamptz;
  v_oldest     timestamptz;
  v_sends      integer;
  v_expires    timestamptz;
begin
  -- One send at a time per profile: two taps on a slow connection should cost
  -- one SMS, not two, and the cooldown below can only be trusted under a lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('zevi.phone_otp:' || p_profile_id::text));

  if p_mobile !~ '^\+[1-9][0-9]{7,14}$' then
    return query select 'invalid_mobile'::text, null::integer, null::timestamptz;
    return;
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_profile_id) then
    return query select 'unknown_profile'::text, null::integer, null::timestamptz;
    return;
  end if;

  if exists (
    select 1 from public.profiles p
    where p.mobile = p_mobile
      and p.mobile_verified_at is not null
      and p.id <> p_profile_id
  ) then
    return query select 'mobile_taken'::text, null::integer, null::timestamptz;
    return;
  end if;

  select max(pv.created_at) into v_last_sent
  from public.phone_verifications pv
  where pv.profile_id = p_profile_id;

  if v_last_sent is not null and v_last_sent > now() - make_interval(secs => v_cooldown) then
    return query select
      'cooldown'::text,
      ceil(extract(epoch from (v_last_sent + make_interval(secs => v_cooldown)) - now()))::integer,
      null::timestamptz;
    return;
  end if;

  select count(*), min(pv.created_at) into v_sends, v_oldest
  from public.phone_verifications pv
  where pv.profile_id = p_profile_id
    and pv.created_at > now() - interval '1 hour';

  if v_sends >= v_max_hourly then
    return query select
      'rate_limited'::text,
      ceil(extract(epoch from (v_oldest + interval '1 hour') - now()))::integer,
      null::timestamptz;
    return;
  end if;

  -- A new code invalidates the old one. Without this, an OTP mailed twice
  -- leaves two valid codes and doubles the guessing surface.
  update public.phone_verifications pv
     set expires_at = now()
   where pv.profile_id = p_profile_id
     and pv.consumed_at is null
     and pv.expires_at > now();

  v_expires := now() + make_interval(secs => v_ttl);

  insert into public.phone_verifications (profile_id, mobile, otp_hash, expires_at, request_ip)
  values (
    p_profile_id,
    p_mobile,
    extensions.crypt(p_otp, extensions.gen_salt('bf', 10)),
    v_expires,
    p_request_ip
  );

  return query select 'sent'::text, null::integer, v_expires;
end;
$$;

comment on function public.request_phone_verification is
  'Stores a hashed mobile OTP under a cooldown and an hourly cap. service_role only.';

-- ----------------------------------------------------------------------------
-- verify_phone_otp
--
-- The only writer of profiles.mobile and profiles.mobile_verified_at, which is
-- why the number is never stored before it has been proven: an unverified
-- write would consume the unique index and let anyone squat a number they do
-- not own.
--
-- Returns one row. `status` is one of:
--   verified · invalid · expired · too_many_attempts · no_code · mobile_taken
-- ----------------------------------------------------------------------------

create or replace function public.verify_phone_otp(
  p_profile_id uuid,
  p_otp        text
)
returns table (status text, attempts_left integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_attempts integer := public.setting_int('auth.otp_max_attempts', 5);
  v_row          public.phone_verifications%rowtype;
begin
  select * into v_row
  from public.phone_verifications pv
  where pv.profile_id = p_profile_id
    and pv.consumed_at is null
  order by pv.created_at desc
  limit 1
  for update;

  if not found then
    return query select 'no_code'::text, null::integer;
    return;
  end if;

  if v_row.expires_at <= now() then
    return query select 'expired'::text, null::integer;
    return;
  end if;

  if v_row.attempts >= v_max_attempts then
    return query select 'too_many_attempts'::text, 0;
    return;
  end if;

  if v_row.otp_hash <> extensions.crypt(p_otp, v_row.otp_hash) then
    update public.phone_verifications
       set attempts = attempts + 1
     where id = v_row.id;

    return query select 'invalid'::text, greatest(v_max_attempts - (v_row.attempts + 1), 0);
    return;
  end if;

  update public.phone_verifications
     set consumed_at = now()
   where id = v_row.id;

  -- Someone else may have verified the same number between the send and this
  -- call. The unique index is the arbiter; the sub-block keeps its rejection
  -- from rolling back the consumption above.
  begin
    update public.profiles
       set mobile             = v_row.mobile,
           mobile_verified_at = now()
     where id = p_profile_id;
  exception when unique_violation then
    return query select 'mobile_taken'::text, null::integer;
    return;
  end;

  return query select 'verified'::text, null::integer;
end;
$$;

comment on function public.verify_phone_otp is
  'Checks a mobile OTP and, on success, stamps profiles.mobile_verified_at. service_role only.';

-- Neither function is safe to expose to a signed-in user: one sends an SMS,
-- the other decides that a number is proven. Both run server-side only.
revoke execute on function public.request_phone_verification(uuid, text, text, inet)
  from public, anon, authenticated;
grant execute on function public.request_phone_verification(uuid, text, text, inet)
  to service_role;

revoke execute on function public.verify_phone_otp(uuid, text) from public, anon, authenticated;
grant execute on function public.verify_phone_otp(uuid, text) to service_role;
