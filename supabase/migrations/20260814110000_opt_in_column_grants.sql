-- ============================================================================
-- Zevi 0028 — narrow the worker's UPDATE on job_opt_ins to withdrawal
--
-- 0007 gave workers an UPDATE policy whose WITH CHECK pins `status` to
-- 'withdrawn'. What it did not pin is which *columns* the same statement may
-- carry along: table-level UPDATE reaches every one of them, so a worker
-- withdrawing an opt-in could rewrite `noticed_detail` — the anti-slop answer a
-- client read before shortlisting — or set `rank_score` by hand, in the same
-- write that the policy approves.
--
-- Nothing in V1 reads either column (no shortlist generation yet, and a
-- withdrawn opt-in is off every screen), so this is closing a door before there
-- is anything behind it. That is the cheap moment to close it. Same shape as
-- the `profiles` and `worker_profiles` grants in 0002: the row is yours, the
-- columns that decide what happens to it are not.
-- ============================================================================

revoke update on public.job_opt_ins from anon, authenticated;
grant update (status, withdrawn_at) on public.job_opt_ins to authenticated;

comment on table public.job_opt_ins is
  'A worker''s bid on an open job: the three short fields from spec §6, written '
  'once. The only column a worker may change afterwards is status, and the only '
  'value the policy accepts is ''withdrawn''.';
