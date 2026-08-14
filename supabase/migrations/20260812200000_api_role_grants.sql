-- ============================================================================
-- Zevi 0020 — API role grants
--
-- Migrations 0001–0019 were written against the historical Supabase baseline:
-- every new table in `public` starts with full DML granted to `anon`,
-- `authenticated` and `service_role`, RLS is the boundary, and a `revoke`
-- narrows anything RLS alone should not be trusted to hold.
--
-- That baseline no longer exists. On this project the default privileges for
-- tables created by `postgres` are:
--
--     anon=Dxtm/postgres | authenticated=Dxtm/postgres | service_role=Dxtm/postgres
--
-- TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — and no SELECT, INSERT, UPDATE or
-- DELETE. So every one of the 81 tables was unreachable through PostgREST:
-- `permission denied for table categories` (42501) for all three roles,
-- before RLS was ever consulted. The policies were correct and untested,
-- because nothing could get far enough to be denied by one.
--
-- This migration restores the baseline the schema assumes, replays every
-- `revoke` the earlier migrations declared, and fixes the default privileges
-- so migration 0021 onwards does not fall into the same hole.
--
-- Grants are not the security boundary here; RLS is, and every table has it
-- enabled with policies that name their roles explicitly. A grant to `anon` on
-- a table with no `to anon` policy still reads nothing.
-- ============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete
  on all tables in schema public
  to anon, authenticated, service_role;

-- Identity columns do not consult sequence privileges, but a future `serial` or
-- standalone sequence would, and would fail the same puzzling way.
grant usage, select on all sequences in schema public to anon, authenticated, service_role;

-- Future tables. `alter default privileges` applies to objects created by the
-- role running it, which is the role that runs migrations (`postgres`).
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;

-- ============================================================================
-- Replay of every table-level revoke declared in 0002–0018, in source order.
-- Each line is a copy of the statement in the migration that created the
-- table. If you change one there, change it here — or better, do not: this
-- file exists to make the earlier ones true, not to restate them forever.
-- ============================================================================

-- 0002 identity -------------------------------------------------------------

-- Users may edit presentation, never their own status or verification stamps.
revoke update on public.profiles from anon, authenticated;
grant update (full_name, display_name, avatar_file_id, locale, timezone)
  on public.profiles to authenticated;
revoke insert, delete on public.profiles from anon, authenticated;

revoke insert, update, delete on public.public_profiles from anon, authenticated;

revoke update on public.worker_profiles from anon, authenticated;
grant update (headline, bio) on public.worker_profiles to authenticated;

revoke insert, update, delete on public.worker_state from anon, authenticated;
revoke update, delete on public.client_profiles from anon, authenticated;
revoke insert, update, delete on public.user_private_stats from anon, authenticated;
revoke all on public.phone_verifications from anon, authenticated;
revoke insert, update, delete on public.user_sanctions from anon, authenticated;
revoke insert, update, delete on public.admin_audit_log from anon, authenticated;

-- 0003a platform settings ---------------------------------------------------

revoke insert, update, delete on public.platform_settings from anon, authenticated;

-- 0003 categories -----------------------------------------------------------

revoke insert, update, delete on public.categories from anon, authenticated;
revoke insert, update, delete on public.category_brief_fields from anon, authenticated;
revoke insert, update, delete on public.worker_category_stats from anon, authenticated;

-- 0004 files ----------------------------------------------------------------

revoke update, delete on public.files from anon, authenticated;

-- 0005 worker onboarding ----------------------------------------------------

revoke insert, update, delete on public.worker_kyc from anon, authenticated;
revoke insert, update, delete on public.payout_methods from anon, authenticated;

-- 0006 jobs -----------------------------------------------------------------

revoke insert, update, delete on public.job_events from anon, authenticated;
revoke insert, update, delete on public.job_moderation from anon, authenticated;
revoke insert, update, delete on public.job_classifications from anon, authenticated;

-- 0007 matching -------------------------------------------------------------

revoke insert, update, delete on public.job_shortlists from anon, authenticated;
revoke insert, update, delete on public.job_shortlist_entries from anon, authenticated;
revoke insert, update, delete on public.job_assignments from anon, authenticated;

-- 0008 delivery -------------------------------------------------------------

revoke update, delete on public.job_deliveries from anon, authenticated;
revoke update, delete on public.delivery_files from anon, authenticated;

-- 0009 chat -----------------------------------------------------------------

revoke insert, update, delete on public.messages from anon, authenticated;
revoke all on public.message_raw from anon;
revoke insert, update, delete on public.message_raw from authenticated;
revoke insert, update, delete on public.message_redactions from anon, authenticated;
revoke insert, update, delete on public.message_attachments from anon, authenticated;
revoke insert, update, delete on public.conversations from anon, authenticated;

-- 0010 money config ---------------------------------------------------------

revoke insert, update, delete on public.commission_slabs from anon, authenticated;
revoke insert, update, delete on public.tax_rates from anon, authenticated;
revoke insert, update, delete on public.fee_schedule from anon, authenticated;
revoke insert, update, delete on public.subscription_plans from anon, authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;

-- 0011 ledger ---------------------------------------------------------------

revoke insert, update, delete on public.ledger_accounts from anon, authenticated;
revoke insert, update, delete on public.ledger_transactions from anon, authenticated;
revoke insert, update, delete on public.ledger_entries from anon, authenticated;
revoke all on public.ledger_account_balances from anon;

-- 0012 payments -------------------------------------------------------------

revoke insert, update, delete on public.payments from anon, authenticated;
revoke insert, update, delete on public.job_financials from anon, authenticated;
revoke insert, update, delete on public.escrow_holds from anon, authenticated;
revoke insert, update, delete on public.cancellations from anon, authenticated;
revoke insert, update, delete on public.refunds from anon, authenticated;
revoke insert, update, delete on public.chargebacks from anon, authenticated;
revoke insert, update, delete on public.documents from anon, authenticated;
revoke insert, update, delete on public.document_lines from anon, authenticated;

-- 0013 payouts --------------------------------------------------------------

revoke insert, update, delete on public.worker_earnings from anon, authenticated;
revoke insert, update, delete on public.payout_batches from anon, authenticated;
revoke insert, update, delete on public.payouts from anon, authenticated;
revoke insert, update, delete on public.payout_items from anon, authenticated;
revoke insert, update, delete on public.worker_adjustments from anon, authenticated;

-- 0014 ratings --------------------------------------------------------------

revoke insert, update, delete on public.rating_tags from anon, authenticated;
revoke update, delete on public.ratings from anon, authenticated;
revoke update, delete on public.rating_tag_selections from anon, authenticated;

-- 0015 penalties and disputes -----------------------------------------------

revoke insert, update, delete on public.penalties from anon, authenticated;
revoke update, delete on public.disputes from anon, authenticated;
revoke update, delete on public.dispute_statements from anon, authenticated;
revoke insert, update, delete on public.dispute_ai_summaries from anon, authenticated;
revoke update, delete on public.dispute_appeals from anon, authenticated;
revoke update, delete on public.dispute_evidence from anon, authenticated;

-- 0016 reports, support, risk -----------------------------------------------

revoke update, delete on public.reports from anon, authenticated;
revoke update, delete on public.support_tickets from anon, authenticated;
revoke update, delete on public.support_messages from anon, authenticated;
revoke insert, update, delete on public.user_devices from anon, authenticated;
revoke insert, update, delete on public.user_ip_events from anon, authenticated;
revoke insert, update, delete on public.risk_flags from anon, authenticated;
revoke insert, update, delete on public.user_pair_signals from anon, authenticated;

-- 0017 notifications and background jobs ------------------------------------

revoke update on public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;
revoke insert, delete on public.notifications from anon, authenticated;
revoke all on public.email_outbox from anon, authenticated;
revoke all on public.background_jobs from anon, authenticated;
