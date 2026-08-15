-- ============================================================================
-- Zevi 0033 — worker KYC, and the destination a payout can finally go to
--
-- Spec §6, "KYC — before first payout, not at signup":
--
--   Full name   must match bank account
--   PAN         TDS, mandatory above ₹5,000 lifetime
--   Bank + IFSC, or UPI ID      payout destination
--   Date of birth               18+ confirmation
--
--   Verification via Razorpay: penny-drop returns the real account holder name;
--   PAN API returns the registered name. Both compared automatically.
--
--   Rules: name mismatch = blocked, no override · one PAN per account,
--   duplicates flagged · under ₹5,000 lifetime, UPI alone is enough · 3 failed
--   attempts → admin review.
--
-- ---------------------------------------------------------------------------
-- Why this is the last thing standing between the platform and a paid worker
--
-- 0031 built the twice-weekly cycle and left one hole in it, deliberately:
-- `payouts.payout_method_id` is NOT NULL and nothing could create a verified
-- `payout_methods` row, so `build_payout_batch()` skipped every worker, counted
-- them, and rolled their earnings forward. This migration is what fills that
-- hole. Nothing in 0031 changes — the day a worker's `payout_methods` row says
-- `verified`, the existing builder picks them up on the next cutoff.
--
-- ---------------------------------------------------------------------------
-- Three functions, because verification is not instantaneous
--
--   open_worker_kyc_attempt()       the declared facts, and the attempt counted
--        ↓                          before a single network call is made
--   record_worker_kyc_destination() the destination, held `verifying`, with
--        ↓                          Razorpay's contact / fund account / validation ids
--   settle_worker_kyc()             the decision: verified · blocked · failed
--
-- The attempt is counted at the *start*, not the end. A request that dies
-- halfway through a penny drop has still spent one — otherwise the three-attempt
-- ceiling is bypassed by closing the tab, and the penny drop costs real money
-- (spec §6 budgets ₹3–5 per worker) which is exactly what a ceiling is for.
--
-- ---------------------------------------------------------------------------
-- `blocked` is not `rejected`, and the difference is the whole rule
--
-- The `kyc_status` enum has carried both since 0002 and this is what they are
-- for:
--
--   rejected   the attempt failed — the account did not exist, the penny drop
--              bounced, the PAN was not found. Retryable, up to the ceiling,
--              then a human looks at it.
--   blocked    the names did not match. Terminal. `review_worker_kyc()` below
--              refuses to lift it, which is what "no override" means when it is
--              written down as code rather than as a policy someone remembers.
--
-- A worker whose *typing* was wrong is not in either state: the comparison runs
-- against what the bank and the PAN registry returned, and a mismatch means one
-- of those two disagrees with the declared name. That is the case spec §6 wants
-- stopped, and it is stopped for good.
--
-- ---------------------------------------------------------------------------
-- What is never stored
--
-- The full PAN and the full bank account number do not exist in this database.
-- The application sends them to Razorpay, keeps the last four digits and a
-- keyed HMAC (`pan_hash`, `destination_hash`) and discards the rest. The HMAC's
-- pepper lives in the application environment, not in Postgres, so a copy of
-- this database is not a copy of anyone's PAN — and duplicate detection, which
-- is all the hash is for, still works.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Tunables
--
-- Every one of these is a number spec §6 states and might restate. The lifetime
-- threshold in particular is a tax rule, not a product decision, and it will
-- move the year the rule does.
-- ----------------------------------------------------------------------------

insert into public.platform_settings (key, value, value_type, description, is_public) values
  ('kyc.max_attempts', '3', 'int',
   'Failed KYC attempts before the worker is held for admin review (spec §6).', true),
  ('kyc.name_match_min_bps', '850', 'int',
   'Minimum name-match score, in basis points, for KYC to pass. Below it the '
   'account is blocked with no override (spec §6).', false),
  ('kyc.pan_required_above_paise', '500000', 'int',
   'Lifetime earnings above which PAN is mandatory for TDS. Under it, UPI alone '
   'is enough (spec §6).', true),
  ('kyc.penny_drop_amount_paise', '100', 'int',
   'The penny in the penny drop. Razorpay defaults to 100 paise.', false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- Columns 0005 did not know it needed
--
-- `worker_kyc` was designed for the full spec and holds almost everything. Four
-- gaps, all of them about the *attempt* rather than the identity:
--
--   pending_method_id     which destination this attempt is validating, so the
--                         settle step does not have to guess from a status
--   last_failure_code     what went wrong, for the retry copy and the queue
--   last_failure_reason   the same thing in words the worker can act on
--   submitted_at          when the current attempt started, which orders the
--                         review queue. `updated_at` moves for other reasons.
-- ----------------------------------------------------------------------------

alter table public.worker_kyc
  add column if not exists pending_method_id    uuid references public.payout_methods (id) on delete set null,
  add column if not exists last_failure_code    text,
  add column if not exists last_failure_reason  text,
  add column if not exists submitted_at         timestamptz;

-- The admin queue: everything a human has been asked to look at. Broader than
-- 0005's `worker_kyc_review_queue_idx`, which predates the duplicate-PAN flag
-- being something anyone acts on.
create index if not exists worker_kyc_attention_idx
  on public.worker_kyc (submitted_at)
  where duplicate_pan_flagged
     or attempts >= 3
     or status in ('verifying', 'rejected');

-- ============================================================================
-- worker_lifetime_earnings_paise — the ₹5,000 line
--
-- Spec §6 makes PAN mandatory "above ₹5,000 lifetime" and says UPI alone is
-- enough under it. Lifetime of *what* is the only judgement here: it is what the
-- worker has actually earned, so it counts every earning that has not been taken
-- back. `pending` counts — the job is delivered and accepted-or-waiting, and a
-- worker who crosses the line during the 48-hour maturity should not be able to
-- complete KYC without a PAN by being quick about it.
--
-- `worker_state.lifetime_earnings_paise` exists and is not used here. Nothing on
-- the platform writes it yet, and a threshold that decides a tax obligation
-- should read the ledger of earnings rather than a counter nobody maintains.
-- ============================================================================

create or replace function public.worker_lifetime_earnings_paise(p_worker_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.net_paise), 0)::bigint
  from public.worker_earnings e
  where e.worker_id = p_worker_id
    and e.status not in (
      'reversed'::public.earning_status,
      'forfeited'::public.earning_status
    );
$$;

comment on function public.worker_lifetime_earnings_paise is
  'Total net earnings that have not been reversed or forfeited. Decides whether '
  'PAN is mandatory (spec §6, ₹5,000) (0033).';

-- ============================================================================
-- open_worker_kyc_attempt — the declared facts, and the attempt spent
--
-- Runs before Razorpay is called. It establishes that this worker is allowed to
-- try, records what they say about themselves, counts the attempt and flags a
-- PAN that already belongs to another account.
--
-- Returns one row. `status` is one of:
--   opened            proceed to verification
--   not_a_worker      no worker_profiles row
--   already_verified  nothing to do
--   blocked           name mismatch, terminal; `detail` is the reason
--   in_progress       a validation is already running for this worker
--   in_review         the attempt ceiling is spent; an admin has to act
--   pan_required      lifetime earnings are past the threshold and no PAN came
-- ============================================================================

create or replace function public.open_worker_kyc_attempt(
  p_worker_id  uuid,
  p_legal_name text,
  p_dob        date,
  p_pan_hash   text default null,
  p_pan_last4  text default null
)
returns table (
  status        text,
  attempts_used integer,
  attempts_left integer,
  pan_required  boolean,
  duplicate_pan boolean,
  detail        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kyc       public.worker_kyc%rowtype;
  v_max       integer := public.setting_int('kyc.max_attempts', 3);
  v_threshold bigint  := public.setting_bigint('kyc.pan_required_above_paise', 500000);
  v_lifetime  bigint;
  v_pan_req   boolean;
  v_duplicate boolean := false;
  v_name      text    := nullif(btrim(coalesce(p_legal_name, '')), '');
begin
  if not exists (select 1 from public.worker_profiles wp where wp.profile_id = p_worker_id) then
    return query select 'not_a_worker'::text, 0, 0, false, false, null::text;
    return;
  end if;

  if v_name is null or char_length(v_name) < 2 then
    raise exception 'KYC needs the name on the bank account' using errcode = 'check_violation';
  end if;

  if p_dob is null then
    raise exception 'KYC needs a date of birth' using errcode = 'check_violation';
  end if;

  -- The row is created on first use rather than alongside `worker_state`: a
  -- worker who never reaches a payout never needs one, and spec §6 is explicit
  -- that this is not a signup step.
  insert into public.worker_kyc (worker_id)
  select p_worker_id
  where not exists (select 1 from public.worker_kyc k where k.worker_id = p_worker_id);

  -- Two tabs submitting at once should spend one attempt, not two, and every
  -- decision below is read-then-write.
  select * into v_kyc
  from public.worker_kyc k
  where k.worker_id = p_worker_id
  for update;

  if v_kyc.status = 'verified'::public.kyc_status then
    return query select 'already_verified'::text, v_kyc.attempts, 0, false,
                        v_kyc.duplicate_pan_flagged, null::text;
    return;
  end if;

  -- Spec §6: name mismatch = blocked, no override. Not by retrying, either.
  if v_kyc.status = 'blocked'::public.kyc_status then
    return query select 'blocked'::text, v_kyc.attempts, 0, false,
                        v_kyc.duplicate_pan_flagged, v_kyc.blocked_reason;
    return;
  end if;

  if v_kyc.status = 'verifying'::public.kyc_status then
    return query select 'in_progress'::text, v_kyc.attempts,
                        greatest(v_max - v_kyc.attempts, 0), false,
                        v_kyc.duplicate_pan_flagged, null::text;
    return;
  end if;

  -- Spec §6: 3 failed attempts → admin review. The ceiling is checked before the
  -- attempt is counted, so the third attempt runs and the fourth is refused.
  if v_kyc.attempts >= v_max then
    return query select 'in_review'::text, v_kyc.attempts, 0, false,
                        v_kyc.duplicate_pan_flagged, null::text;
    return;
  end if;

  v_lifetime := public.worker_lifetime_earnings_paise(p_worker_id);
  v_pan_req  := v_lifetime > v_threshold;

  if v_pan_req and p_pan_hash is null then
    return query select 'pan_required'::text, v_kyc.attempts,
                        greatest(v_max - v_kyc.attempts, 0), true,
                        v_kyc.duplicate_pan_flagged, null::text;
    return;
  end if;

  -- One PAN per account, duplicates flagged (spec §6). Flagged, not refused:
  -- 0005 chose that deliberately, and it is the right choice — a household
  -- sharing a PAN and a fraud ring look identical from here, and only one of
  -- them should be stopped. Both sides of the collision are marked so the queue
  -- shows the pair rather than whichever arrived second.
  if p_pan_hash is not null then
    select exists (
      select 1 from public.worker_kyc k
      where k.pan_hash = p_pan_hash and k.worker_id <> p_worker_id
    ) into v_duplicate;

    if v_duplicate then
      update public.worker_kyc k
         set duplicate_pan_flagged = true
       where k.pan_hash = p_pan_hash
         and k.worker_id <> p_worker_id
         and not k.duplicate_pan_flagged;
    end if;
  end if;

  -- The previous attempt's results go with it. Leaving a stale `penny_drop_name`
  -- on a fresh attempt is how a later reader concludes the wrong name was
  -- compared.
  update public.worker_kyc k
     set status               = 'submitted'::public.kyc_status,
         legal_name           = v_name,
         date_of_birth        = p_dob,
         pan_hash             = coalesce(p_pan_hash, k.pan_hash),
         pan_last4            = coalesce(p_pan_last4, k.pan_last4),
         duplicate_pan_flagged = k.duplicate_pan_flagged or v_duplicate,
         attempts             = k.attempts + 1,
         submitted_at         = now(),
         penny_drop_name      = null,
         pan_registered_name  = null,
         name_match_score     = null,
         name_match_passed    = null,
         last_failure_code    = null,
         last_failure_reason  = null,
         provider_reference   = null,
         pending_method_id    = null
   where k.worker_id = p_worker_id
  returning * into v_kyc;

  update public.worker_state ws
     set kyc_status = 'submitted'::public.kyc_status
   where ws.profile_id = p_worker_id;

  return query select 'opened'::text, v_kyc.attempts,
                      greatest(v_max - v_kyc.attempts, 0), v_pan_req,
                      v_kyc.duplicate_pan_flagged, null::text;
end;
$$;

comment on function public.open_worker_kyc_attempt is
  'Starts a KYC attempt: records the declared name, DOB and PAN hash, counts the '
  'attempt against the ceiling and flags a duplicate PAN. service_role only (0033).';

-- ============================================================================
-- record_worker_kyc_destination — the account, held pending its penny drop
--
-- Razorpay's fund account validation is asynchronous: the call returns `created`
-- and the bank answers seconds to minutes later. This writes down what was
-- submitted, in the state it is actually in, so a worker who closes the tab has
-- a row that says "verifying" rather than nothing at all.
--
-- The destination is `payout_methods`, which already had every column this
-- needs since 0005 — including `razorpay_fund_account_id` and
-- `razorpay_contact_id`, which is what Route's transfer half will use the day it
-- is wired. A method is never created `verified`; only `settle_worker_kyc()`
-- moves it there, and only after the names have been compared.
--
-- Look-then-insert rather than ON CONFLICT: there is no unique index on
-- (worker_id, destination_hash), and 0032's lesson is that an inference spec is
-- the one place a qualification is not allowed and so the one place an ambiguous
-- column bites. The `for update` on the KYC row is what serialises it.
-- ============================================================================

create or replace function public.record_worker_kyc_destination(
  p_worker_id          uuid,
  p_method_type        public.payout_method_type,
  p_destination_hash   text,
  p_provider_reference text,
  p_ifsc               text default null,
  p_account_last4      text default null,
  p_bank_name          text default null,
  p_upi_masked         text default null,
  p_fund_account_id    text default null,
  p_contact_id         text default null,
  p_label              text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kyc    public.worker_kyc%rowtype;
  v_method public.payout_methods%rowtype;
begin
  select * into v_kyc
  from public.worker_kyc k
  where k.worker_id = p_worker_id
  for update;

  if not found then
    raise exception 'no KYC attempt is open for worker %', p_worker_id
      using errcode = 'no_data_found';
  end if;

  if v_kyc.status <> 'submitted'::public.kyc_status then
    raise exception 'worker % has no open KYC attempt (status %)', p_worker_id, v_kyc.status
      using errcode = 'check_violation';
  end if;

  -- The same destination submitted twice is the same row, re-verified. A second
  -- row would compete for `payout_methods_one_default_idx` and leave a stale
  -- `failed` method behind for the collusion query to trip over.
  select * into v_method
  from public.payout_methods pm
  where pm.worker_id = p_worker_id
    and pm.destination_hash = p_destination_hash
  order by pm.created_at
  limit 1
  for update;

  if found then
    update public.payout_methods pm
       set type                 = p_method_type,
           status               = 'verifying'::public.payout_method_status,
           label                = coalesce(p_label, pm.label),
           bank_name            = coalesce(p_bank_name, pm.bank_name),
           ifsc                 = p_ifsc,
           account_last4        = p_account_last4,
           upi_handle_masked    = p_upi_masked,
           razorpay_fund_account_id = coalesce(p_fund_account_id, pm.razorpay_fund_account_id),
           razorpay_contact_id  = coalesce(p_contact_id, pm.razorpay_contact_id),
           verified_at          = null,
           consecutive_failures = 0,
           last_failure_reason  = null,
           disabled_at          = null
     where pm.id = v_method.id
    returning * into v_method;
  else
    insert into public.payout_methods (
      worker_id, type, status, label, bank_name, ifsc, account_last4,
      upi_handle_masked, destination_hash, razorpay_fund_account_id, razorpay_contact_id
    )
    values (
      p_worker_id, p_method_type, 'verifying'::public.payout_method_status, p_label,
      p_bank_name, p_ifsc, p_account_last4, p_upi_masked, p_destination_hash,
      p_fund_account_id, p_contact_id
    )
    returning * into v_method;
  end if;

  update public.worker_kyc k
     set status             = 'verifying'::public.kyc_status,
         pending_method_id  = v_method.id,
         provider_reference = p_provider_reference
   where k.worker_id = p_worker_id;

  update public.worker_state ws
     set kyc_status = 'verifying'::public.kyc_status
   where ws.profile_id = p_worker_id;

  return v_method.id;
end;
$$;

comment on function public.record_worker_kyc_destination is
  'Stores the payout destination a KYC attempt is validating, as `verifying`, '
  'with Razorpay''s contact, fund account and validation ids. service_role only (0033).';

-- ============================================================================
-- settle_worker_kyc — the decision
--
-- One transaction, because the three things it writes are one fact. A
-- `worker_kyc` row that says verified beside a `payout_methods` row that does
-- not is a worker the batch builder skips forever while their dashboard tells
-- them they are ready.
--
-- Takes no judgement of its own — the name comparison happens in
-- `lib/kyc/names.ts`, where it is a pure function with tests against the ways
-- Indian names legitimately vary. What this enforces is that the *outcomes* are
-- the three spec §6 allows and that `blocked` is one of them.
--
-- Returns one row. `status` is one of:
--   settled · not_found · already_final
-- ============================================================================

create or replace function public.settle_worker_kyc(
  p_worker_id           uuid,
  p_outcome             text,
  p_penny_drop_name     text default null,
  p_pan_registered_name text default null,
  p_name_match_score    numeric default null,
  p_reason              text default null,
  p_failure_code        text default null
)
returns table (
  status        text,
  kyc_status    public.kyc_status,
  attempts_used integer,
  attempts_left integer,
  in_review     boolean,
  detail        text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kyc    public.worker_kyc%rowtype;
  v_max    integer := public.setting_int('kyc.max_attempts', 3);
  v_reason text    := nullif(btrim(coalesce(p_reason, '')), '');
  v_now    timestamptz := now();
begin
  if p_outcome not in ('verified', 'blocked', 'failed') then
    raise exception 'unknown KYC outcome %', p_outcome using errcode = 'check_violation';
  end if;

  select * into v_kyc
  from public.worker_kyc k
  where k.worker_id = p_worker_id
  for update;

  if not found then
    return query select 'not_found'::text, null::public.kyc_status, 0, 0, false, null::text;
    return;
  end if;

  -- Idempotent, and it has to be: the settle path is reachable from the worker's
  -- own page reload as well as from whatever finishes the validation, and both
  -- may run against a row that is already decided.
  if v_kyc.status in ('verified'::public.kyc_status, 'blocked'::public.kyc_status) then
    return query select 'already_final'::text, v_kyc.status, v_kyc.attempts, 0, false,
                        v_kyc.blocked_reason;
    return;
  end if;

  if p_outcome = 'verified' then
    update public.worker_kyc k
       set status              = 'verified'::public.kyc_status,
           penny_drop_name     = coalesce(p_penny_drop_name, k.penny_drop_name),
           pan_registered_name = coalesce(p_pan_registered_name, k.pan_registered_name),
           name_match_score    = coalesce(p_name_match_score, k.name_match_score),
           name_match_passed   = true,
           blocked_reason      = null,
           last_failure_code   = null,
           last_failure_reason = null,
           verified_at         = v_now
     where k.worker_id = p_worker_id
    returning * into v_kyc;

    if v_kyc.pending_method_id is not null then
      -- `payout_methods_one_default_idx` allows one live default per worker, so
      -- the previous one steps aside before this one becomes it.
      update public.payout_methods pm
         set is_default = false
       where pm.worker_id = p_worker_id
         and pm.id <> v_kyc.pending_method_id
         and pm.is_default;

      update public.payout_methods pm
         set status               = 'verified'::public.payout_method_status,
             verified_at          = v_now,
             is_default           = true,
             disabled_at          = null,
             consecutive_failures = 0,
             last_failure_reason  = null
       where pm.id = v_kyc.pending_method_id;
    end if;

  elsif p_outcome = 'blocked' then
    update public.worker_kyc k
       set status              = 'blocked'::public.kyc_status,
           penny_drop_name     = coalesce(p_penny_drop_name, k.penny_drop_name),
           pan_registered_name = coalesce(p_pan_registered_name, k.pan_registered_name),
           name_match_score    = coalesce(p_name_match_score, k.name_match_score),
           name_match_passed   = false,
           blocked_reason      = coalesce(v_reason, 'The name did not match the account.'),
           last_failure_code   = coalesce(p_failure_code, 'name_mismatch'),
           last_failure_reason = v_reason
     where k.worker_id = p_worker_id
    returning * into v_kyc;

    -- A destination reached under a name that is not the worker's is not a
    -- destination to keep on file.
    if v_kyc.pending_method_id is not null then
      update public.payout_methods pm
         set status              = 'failed'::public.payout_method_status,
             is_default          = false,
             disabled_at         = v_now,
             last_failure_reason = v_kyc.blocked_reason
       where pm.id = v_kyc.pending_method_id;
    end if;

  else
    update public.worker_kyc k
       set status              = 'rejected'::public.kyc_status,
           penny_drop_name     = coalesce(p_penny_drop_name, k.penny_drop_name),
           pan_registered_name = coalesce(p_pan_registered_name, k.pan_registered_name),
           name_match_score    = coalesce(p_name_match_score, k.name_match_score),
           last_failure_code   = p_failure_code,
           last_failure_reason = v_reason
     where k.worker_id = p_worker_id
    returning * into v_kyc;

    if v_kyc.pending_method_id is not null then
      update public.payout_methods pm
         set status               = 'failed'::public.payout_method_status,
             is_default           = false,
             disabled_at          = v_now,
             consecutive_failures = pm.consecutive_failures + 1,
             last_failure_reason  = v_reason
       where pm.id = v_kyc.pending_method_id;
    end if;
  end if;

  update public.worker_state ws
     set kyc_status = v_kyc.status
   where ws.profile_id = p_worker_id;

  return query select
    'settled'::text,
    v_kyc.status,
    v_kyc.attempts,
    greatest(v_max - v_kyc.attempts, 0),
    v_kyc.status = 'rejected'::public.kyc_status and v_kyc.attempts >= v_max,
    coalesce(v_kyc.blocked_reason, v_kyc.last_failure_reason);
end;
$$;

comment on function public.settle_worker_kyc is
  'Applies a KYC outcome — verified, blocked (name mismatch, terminal) or failed '
  '— to worker_kyc, payout_methods and worker_state in one transaction. '
  'service_role only (0033).';

-- ============================================================================
-- review_worker_kyc — the human at the end of three failed attempts
--
-- Spec §6's last rule: "3 failed attempts → admin review". Two decisions, and
-- deliberately not three:
--
--   allow_retry   the attempt counter goes back to zero. For the cases that are
--                 not the worker's fault — a bank that was down, an IFSC that
--                 had just changed, a penny drop that timed out.
--   reject        the account is turned away for this cycle of attempts and the
--                 destination on file is disabled.
--
-- There is no `unblock`. A `blocked` row is a name mismatch and spec §6 says it
-- has no override, so this refuses rather than offering one — that is the only
-- way "no override" survives contact with a support queue at 6pm on a Friday.
--
-- Returns one row. `status` is one of:
--   reviewed · not_found · forbidden · invalid_decision · reason_required ·
--   blocked_no_override
-- ============================================================================

create or replace function public.review_worker_kyc(
  p_worker_id   uuid,
  p_reviewer_id uuid,
  p_decision    text,
  p_reason      text
)
returns table (status text, kyc_status public.kyc_status, detail text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kyc    public.worker_kyc%rowtype;
  v_before jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_new    public.kyc_status;
begin
  if p_decision not in ('allow_retry', 'reject') then
    return query select 'invalid_decision'::text, null::public.kyc_status, null::text;
    return;
  end if;

  if v_reason is null or char_length(v_reason) < 3 then
    return query select 'reason_required'::text, null::public.kyc_status, null::text;
    return;
  end if;

  -- Same reason as `review_worker_application()`: under the service-role key
  -- auth.uid() is null, so admin_can() would answer false for a super admin.
  if not exists (
    select 1
    from public.admin_users au
    join public.admin_roles r on r.id = au.role_id
    where au.profile_id = p_reviewer_id
      and au.is_active
      and (r.is_super or 'manage_payouts' = any (r.permissions))
  ) then
    return query select 'forbidden'::text, null::public.kyc_status, null::text;
    return;
  end if;

  select * into v_kyc
  from public.worker_kyc k
  where k.worker_id = p_worker_id
  for update;

  if not found then
    return query select 'not_found'::text, null::public.kyc_status, null::text;
    return;
  end if;

  if v_kyc.status = 'blocked'::public.kyc_status then
    return query select 'blocked_no_override'::text, v_kyc.status, v_kyc.blocked_reason;
    return;
  end if;

  v_before := to_jsonb(v_kyc);
  v_new    := case when p_decision = 'allow_retry'
                   then 'not_started'::public.kyc_status
                   else 'rejected'::public.kyc_status end;

  update public.worker_kyc k
     set status              = v_new,
         attempts            = case when p_decision = 'allow_retry' then 0 else k.attempts end,
         last_failure_code   = case when p_decision = 'allow_retry' then null else 'admin_rejected' end,
         last_failure_reason = case when p_decision = 'allow_retry' then null else v_reason end,
         pending_method_id   = case when p_decision = 'allow_retry' then null else k.pending_method_id end,
         reviewed_by         = p_reviewer_id,
         reviewed_at         = now()
   where k.worker_id = p_worker_id
  returning * into v_kyc;

  -- Either way the destination on file stops being one money can go to. On a
  -- retry the worker submits it again and it is validated again; leaving a
  -- half-verified account live between the two is how a payout finds a
  -- destination nobody checked.
  update public.payout_methods pm
     set status              = 'failed'::public.payout_method_status,
         is_default          = false,
         disabled_at         = now(),
         last_failure_reason = v_reason
   where pm.worker_id = p_worker_id
     and pm.status <> 'verified'::public.payout_method_status
     and pm.disabled_at is null;

  update public.worker_state ws
     set kyc_status = v_kyc.status
   where ws.profile_id = p_worker_id;

  insert into public.admin_audit_log (
    admin_id, action, target_table, target_id, reason, before_state, after_state
  )
  values (
    p_reviewer_id,
    case when p_decision = 'allow_retry' then 'kyc.retry_allowed' else 'kyc.rejected' end,
    'worker_kyc',
    p_worker_id,
    v_reason,
    v_before,
    to_jsonb(v_kyc)
  );

  return query select 'reviewed'::text, v_kyc.status, null::text;
end;
$$;

comment on function public.review_worker_kyc is
  'Admin decision on a KYC held for review: allow another set of attempts, or '
  'reject. Refuses to lift a `blocked` row — spec §6 gives a name mismatch no '
  'override. service_role only (0033).';

-- ============================================================================
-- Grants
--
-- Every one of these decides whether money can reach a person. None is callable
-- from a browser; the Server Actions in `lib/kyc/` are the only callers and each
-- re-establishes who is asking before it runs.
-- ============================================================================

revoke execute on function public.worker_lifetime_earnings_paise(uuid)
  from public, anon, authenticated;
grant execute on function public.worker_lifetime_earnings_paise(uuid) to service_role;

revoke execute on function public.open_worker_kyc_attempt(uuid, text, date, text, text)
  from public, anon, authenticated;
grant execute on function public.open_worker_kyc_attempt(uuid, text, date, text, text)
  to service_role;

revoke execute on function public.record_worker_kyc_destination(
  uuid, public.payout_method_type, text, text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_worker_kyc_destination(
  uuid, public.payout_method_type, text, text, text, text, text, text, text, text, text
) to service_role;

revoke execute on function public.settle_worker_kyc(uuid, text, text, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_worker_kyc(uuid, text, text, text, numeric, text, text)
  to service_role;

revoke execute on function public.review_worker_kyc(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.review_worker_kyc(uuid, uuid, text, text) to service_role;
