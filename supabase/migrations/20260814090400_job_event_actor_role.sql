-- ============================================================================
-- Zevi 0026 — the status trigger could never fire
--
-- `log_job_status_change()` decides who moved the job with a CASE whose four
-- branches are all bare string literals:
--
--     case when auth.uid() = new.client_id then 'client'
--          ...
--          else 'admin' end
--
-- With nothing in it but unknown literals, Postgres resolves the CASE to
-- `text` — and `job_events.actor_role` is `public.party_role`, so the insert
-- fails:
--
--     column "actor_role" is of type public.party_role but expression is of
--     type text                                                        (42804)
--
-- The INSERT branch of the same function is fine, because a bare literal
-- sitting directly in a VALUES list does get coerced to the column's type. Only
-- the CASE is affected — which is why this went unseen: that branch runs on
-- every status change, and until posting existed, no job had ever changed
-- status. It would have taken down publication, assignment, delivery,
-- completion and cancellation alike, each the first time it was tried.
--
-- Casting the CASE is the whole fix. The draft-skipping behaviour from 0024 is
-- carried through unchanged.
-- ============================================================================

create or replace function public.log_job_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A draft is private and disposable, so it earns no timeline (0024). A job
  -- inserted straight into any other status still does.
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      insert into public.job_events (job_id, actor_id, actor_role, event_type, to_status)
      values (new.id, new.client_id, 'client'::public.party_role, 'job.created', new.status);
    end if;
  elsif new.status is distinct from old.status then
    insert into public.job_events (job_id, actor_id, actor_role, event_type, from_status, to_status)
    values (
      new.id,
      (select auth.uid()),
      (case when (select auth.uid()) = new.client_id then 'client'
            when (select auth.uid()) = new.assigned_worker_id then 'worker'
            when (select auth.uid()) is null then 'system'
            else 'admin' end)::public.party_role,
      'job.status_changed',
      old.status,
      new.status
    );
  end if;
  return null;
end;
$$;

comment on function public.log_job_status_change is
  'Trigger: appends to job_events on publication and on every later status '
  'change. Drafts are skipped (0024); the actor CASE is cast (0026).';
