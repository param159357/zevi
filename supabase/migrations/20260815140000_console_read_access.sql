-- ============================================================================
-- Zevi 0035 — two reads the console needs and could not make
--
-- 0034 gave the console its decisions. Building the screens around them turned
-- up two places where the right answer was a policy rather than a workaround,
-- and CLAUDE.md is explicit about which of those to reach for: never use the
-- service-role client to get around a policy that is inconvenient — fix the
-- policy.
--
--   1. A dispute reviewer cannot see what is in escrow.
--   2. Nothing can ask "is this account a console member?" about anyone else.
--
-- Both are small. Both would otherwise have become a service-role read in a
-- query module, which is how a console quietly stops being governed by RLS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Escrow and the frozen price, for the person dividing them
--
-- 0012 gave `escrow_holds` and `job_financials` to job participants and to
-- `view_finance`. The seeded `support` role — the one that actually holds
-- `resolve_disputes` — has neither, so the dispute screen could show a reviewer
-- both statements, the whole chat and every file, and not the amount they were
-- being asked to divide.
--
-- `view_disputes` rather than `resolve_disputes`, to match the rest of the
-- dispute tables: seeing the case and deciding it are separate permissions
-- everywhere else in this schema, and escrow is part of seeing the case.
--
-- Note what this does NOT open: `payments` stays on `view_finance`. A reviewer
-- needs the amount in dispute, not the client's card details or the gateway's
-- cut.
-- ----------------------------------------------------------------------------

drop policy if exists "participants read the escrow state" on public.escrow_holds;

create policy "participants read the escrow state"
  on public.escrow_holds for select to authenticated
  using (
    (select public.is_job_participant(job_id))
    or (select public.admin_can('view_finance'))
    or (select public.admin_can('view_disputes'))
  );

drop policy if exists "participants read the job price" on public.job_financials;

create policy "participants read the job price"
  on public.job_financials for select to authenticated
  using (
    (select public.is_job_participant(job_id))
    or (select public.admin_can('view_finance'))
    or (select public.admin_can('view_disputes'))
  );

-- ----------------------------------------------------------------------------
-- 2. is_admin_account — "is *this* account in the console?"
--
-- `admin_users` has RLS enabled and no policies at all, which is deliberate and
-- right: membership is granted out of band with the service-role key and there
-- is no API path to the table. The consequence is that a direct SELECT comes
-- back empty for everyone, including a super admin — so the user-management
-- screen would cheerfully offer to ban a colleague, and only
-- `apply_user_sanction()` would stop it, after the click.
--
-- `is_admin()` already answers this about the caller. This is the same question
-- about someone else, and the same shape as `is_active_worker(uuid)`: a
-- security-definer function that returns a boolean rather than a policy that
-- hands out the membership list.
--
-- Granted to `authenticated` and not gated on being an admin, for the reason
-- `is_active_worker` is not either: it leaks one bit about an account that
-- anyone could infer from the console's existence, and gating it would mean a
-- second admin lookup on every call to answer a question the caller has already
-- earned by reaching a `requireAdmin` page.
-- ----------------------------------------------------------------------------

create or replace function public.is_admin_account(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users au
    where au.profile_id = p_profile_id and au.is_active
  );
$$;

comment on function public.is_admin_account is
  'Whether a given account is an active console member. The `uuid` counterpart '
  'to is_admin(), for screens that act on someone else — apply_user_sanction() '
  'refuses a console member and this is what lets the UI say so first (0035).';

grant execute on function public.is_admin_account(uuid) to authenticated;
