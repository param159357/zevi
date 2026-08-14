-- ============================================================================
-- Zevi 0024 — a draft leaves no timeline behind
--
-- 0006 gave `jobs` a DELETE policy for drafts ("clients delete their own
-- drafts") and, in the same migration, a trigger that writes a `job.created`
-- row into `job_events` on every INSERT. `job_events.job_id` is
-- `on delete restrict` and the table is append-only, so those two features
-- cancel each other out: every draft acquires an undeletable child row the
-- moment it exists, and the delete policy can never once succeed.
--
--     delete on table "jobs" violates foreign key constraint
--     "job_events_job_id_fkey" on table "job_events"    (23503)
--
-- Nothing had noticed because nothing deleted a draft until the posting form
-- got a Discard button.
--
-- The fix is to stop writing the row rather than to weaken the restrict. The
-- timeline is the evidence trail behind a dispute or a chargeback, and a draft
-- has no counterparty, no money and no audience — there is nothing about it to
-- evidence. It starts being logged the moment it becomes something a worker can
-- see, which the status-change branch below and `publish_job()` both cover.
-- ============================================================================

create or replace function public.log_job_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- A draft is private and disposable, so it earns no timeline. A job inserted
  -- straight into any other status still does.
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      insert into public.job_events (job_id, actor_id, actor_role, event_type, to_status)
      values (new.id, new.client_id, 'client', 'job.created', new.status);
    end if;
  elsif new.status is distinct from old.status then
    insert into public.job_events (job_id, actor_id, actor_role, event_type, from_status, to_status)
    values (
      new.id,
      (select auth.uid()),
      case when (select auth.uid()) = new.client_id then 'client'
           when (select auth.uid()) = new.assigned_worker_id then 'worker'
           when (select auth.uid()) is null then 'system'
           else 'admin' end,
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
  'change. Drafts are skipped — see migration 0024.';

-- ----------------------------------------------------------------------------
-- The rows already written
--
-- One-time, and the only DELETE this schema will ever run against an
-- append-only table. It is scoped to `job.created` rows belonging to jobs that
-- are *still drafts*: no published job's timeline is touched, and every row it
-- removes is one the function above would no longer write. The trigger goes
-- straight back on.
-- ----------------------------------------------------------------------------

alter table public.job_events disable trigger job_events_is_append_only;

delete from public.job_events e
using public.jobs j
where e.job_id = j.id
  and j.status = 'draft'
  and e.event_type = 'job.created';

alter table public.job_events enable trigger job_events_is_append_only;
