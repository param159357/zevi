-- ============================================================================
-- Zevi 0001 — extensions, enum types, generic helpers
--
-- Nothing in this file creates a table. It exists so every later migration can
-- assume the vocabulary of the domain already exists.
--
-- Conventions used throughout the schema:
--   * every timestamp is `timestamptz`, named `<verb>_at`
--   * every money column is `bigint` holding PAISE — never numeric, never float
--   * enums over free text wherever the value set is closed and known
--   * every table gets RLS in the same migration that creates it
-- ============================================================================

create extension if not exists pgcrypto with schema extensions;
-- btree_gist lets an exclusion constraint mix scalar equality with range
-- overlap — used in 0010 to guarantee no two commission slabs, tax rates or
-- fees can ever cover the same value at the same moment.
create extension if not exists btree_gist with schema extensions;

-- ----------------------------------------------------------------------------
-- Identity, access, moderation
-- ----------------------------------------------------------------------------

create type public.account_status as enum (
  'active', 'restricted', 'suspended', 'banned', 'deactivated'
);

-- Single super-admin at launch, but the permission set is modelled now so a
-- support role can see disputes without touching payouts (spec §7).
create type public.admin_permission as enum (
  'manage_admins',
  'manage_users',
  'review_workers',
  'view_disputes',
  'resolve_disputes',
  'manage_payouts',
  'view_finance',
  'manage_categories',
  'manage_settings',
  'resolve_reports',
  'handle_support',
  'view_audit_log'
);

create type public.party_role as enum ('client', 'worker', 'admin', 'system');

create type public.sanction_type as enum (
  'warning',
  'rating_penalty',
  'shortlist_removal',
  'sample_resubmission',
  'suspension',
  'ban'
);

-- ----------------------------------------------------------------------------
-- Worker lifecycle
-- ----------------------------------------------------------------------------

create type public.worker_status as enum (
  'draft', 'pending_approval', 'approved', 'approved_with_flag',
  'rejected', 'suspended', 'removed'
);

create type public.worker_tier as enum ('new', 'established', 'top');

create type public.worker_application_status as enum (
  'draft', 'submitted', 'approved', 'approved_with_flag', 'rejected', 'withdrawn'
);

create type public.sample_status as enum ('pending', 'approved', 'rejected', 'flagged');

create type public.kyc_status as enum (
  'not_started', 'submitted', 'verifying', 'verified', 'rejected', 'blocked'
);

create type public.payout_method_type as enum ('bank_account', 'upi');

create type public.payout_method_status as enum (
  'unverified', 'verifying', 'verified', 'failed', 'disabled'
);

-- ----------------------------------------------------------------------------
-- Categories and briefs
-- ----------------------------------------------------------------------------

create type public.category_status as enum ('active', 'hidden', 'retired');

create type public.brief_field_type as enum (
  'text', 'long_text', 'number', 'select', 'multi_select', 'boolean', 'file_format'
);

-- ----------------------------------------------------------------------------
-- Jobs
-- ----------------------------------------------------------------------------

create type public.job_status as enum (
  'draft',
  'pending_moderation',
  'open',
  'assigned',
  'delivered',
  'revision_requested',
  'disputed',
  'completed',
  'cancelled',
  'expired',
  'rejected'
);

create type public.moderation_trigger as enum (
  'other_category', 'first_high_value_job', 'user_report',
  'keyword_flag', 'random_audit', 'risk_score'
);

create type public.moderation_status as enum ('pending', 'approved', 'rejected', 'escalated');

-- Mirrors the prohibited-work list in spec §13.
create type public.moderation_reason as enum (
  'academic_submission',
  'credential_sharing',
  'adult_content',
  'impersonation',
  'illegal_or_harmful',
  'copyright_infringement',
  'deceptive_material',
  'other'
);

create type public.classification_status as enum (
  'pending', 'classified', 'low_confidence', 'admin_review', 'resolved', 'failed'
);

-- ----------------------------------------------------------------------------
-- Matching
-- ----------------------------------------------------------------------------

create type public.opt_in_status as enum (
  'active', 'shortlisted', 'selected', 'not_selected', 'withdrawn', 'expired'
);

create type public.shortlist_slot as enum ('top', 'middle', 'newest');

create type public.assignment_source as enum ('shortlist', 'rehire', 'admin');

create type public.assignment_status as enum (
  'active', 'completed', 'cancelled', 'abandoned', 'replaced'
);

create type public.rehire_status as enum (
  'pending', 'accepted', 'declined', 'expired', 'withdrawn'
);

-- ----------------------------------------------------------------------------
-- Delivery
-- ----------------------------------------------------------------------------

create type public.delivery_status as enum (
  'pending_review', 'accepted', 'revision_requested', 'disputed', 'superseded'
);

create type public.revision_status as enum (
  'requested', 'accepted_by_worker', 'declined_by_worker', 'delivered', 'cancelled'
);

-- ----------------------------------------------------------------------------
-- Files
-- ----------------------------------------------------------------------------

create type public.file_purpose as enum (
  'job_attachment', 'delivery', 'sample', 'chat_attachment',
  'dispute_evidence', 'kyc_document', 'avatar', 'document'
);

create type public.file_scan_status as enum ('pending', 'clean', 'infected', 'skipped', 'failed');

-- ----------------------------------------------------------------------------
-- Money
-- ----------------------------------------------------------------------------

create type public.payment_status as enum (
  'created', 'authorized', 'captured', 'failed',
  'refunded', 'partially_refunded', 'charged_back'
);

create type public.escrow_status as enum ('held', 'frozen', 'released', 'refunded', 'split');

create type public.refund_reason as enum (
  'client_cancellation',
  'worker_abandonment',
  'dispute_refund',
  'dispute_split',
  'prohibited_work',
  'job_expired',
  'admin_adjustment',
  'chargeback'
);

create type public.refund_status as enum ('pending', 'processing', 'completed', 'failed');

-- Named for the tiers in spec §5, not for the percentages, so re-tuning the
-- percentages never needs a type change.
create type public.cancellation_tier as enum (
  'pre_assignment', 'early', 'mid', 'late', 'post_delivery'
);

create type public.chargeback_status as enum (
  'open', 'evidence_submitted', 'won', 'lost', 'cancelled'
);

create type public.earning_status as enum (
  'pending', 'confirmed', 'on_hold', 'frozen',
  'in_payout', 'paid', 'reversed', 'forfeited'
);

create type public.payout_batch_status as enum (
  'open', 'closed', 'under_review', 'processing', 'completed', 'failed'
);

create type public.payout_status as enum (
  'pending', 'processing', 'paid', 'failed', 'cancelled'
);

create type public.payout_item_kind as enum ('earning', 'penalty', 'adjustment', 'reversal');

create type public.ledger_account_type as enum (
  'escrow',
  'worker_payable',
  'platform_revenue',
  'tax_payable',
  'gateway_fees',
  'chargeback_reserve',
  'penalty_receivable',
  'external'
);

create type public.ledger_direction as enum ('debit', 'credit');

create type public.ledger_txn_kind as enum (
  'payment_captured',
  'commission_charged',
  'tax_charged',
  'escrow_released',
  'refund_issued',
  'payout_created',
  'payout_paid',
  'payout_failed',
  'penalty_applied',
  'penalty_recovered',
  'chargeback_opened',
  'chargeback_lost',
  'chargeback_won',
  'reserve_transfer',
  'subscription_charged',
  'adjustment'
);

create type public.document_type as enum (
  'client_receipt', 'commission_invoice', 'credit_note', 'payout_advice', 'refund_note'
);

create type public.document_line_kind as enum (
  'job_budget', 'commission', 'tax', 'fee', 'discount', 'refund', 'penalty', 'net_payable'
);

create type public.plan_audience as enum ('worker', 'client');

create type public.subscription_status as enum (
  'active', 'past_due', 'cancelled', 'expired', 'paused'
);

-- ----------------------------------------------------------------------------
-- Ratings, disputes, penalties
-- ----------------------------------------------------------------------------

create type public.rating_direction as enum ('client_to_worker', 'worker_to_client');

create type public.rating_sentiment as enum ('positive', 'neutral', 'negative');

create type public.dispute_layer as enum (
  'auto_resolved', 'self_settlement', 'admin_review', 'instant_split'
);

create type public.dispute_status as enum (
  'open', 'awaiting_response', 'self_settlement', 'admin_review',
  'resolved', 'appealed', 'closed'
);

create type public.dispute_outcome as enum ('release', 'refund', 'split');

create type public.dispute_offer_status as enum (
  'pending', 'accepted', 'countered', 'rejected', 'expired'
);

create type public.penalty_type as enum (
  'abandonment',
  'off_platform_contact',
  'plagiarism',
  'low_rating',
  'prohibited_work',
  'late_delivery',
  'chargeback_fraud',
  'sample_theft',
  'collusion'
);

create type public.penalty_status as enum ('active', 'settled', 'waived', 'reversed');

-- ----------------------------------------------------------------------------
-- Reports, support, risk
-- ----------------------------------------------------------------------------

create type public.report_reason as enum (
  'abuse', 'plagiarism', 'off_platform_contact', 'impersonation',
  'prohibited_work', 'spam', 'other'
);

create type public.report_status as enum ('open', 'reviewing', 'actioned', 'dismissed');

create type public.ticket_status as enum (
  'open', 'waiting_on_user', 'waiting_on_admin', 'resolved', 'closed'
);

-- The collusion signals from spec §10. No ML — these are countable facts.
create type public.risk_flag_kind as enum (
  'shared_device',
  'shared_ip',
  'shared_payout_destination',
  'duplicate_pan',
  'fast_completion',
  'always_five_star',
  'no_chat_activity',
  'closed_pair',
  'velocity',
  'name_mismatch'
);

create type public.risk_flag_status as enum ('open', 'cleared', 'confirmed');

-- ----------------------------------------------------------------------------
-- Notifications and background work
-- ----------------------------------------------------------------------------

create type public.notification_type as enum (
  'email_verification',
  'mobile_verification',
  'payment_received',
  'shortlist_ready',
  'worker_assigned',
  'work_delivered',
  'auto_accept_reminder',
  'job_completed',
  'refund_issued',
  'dispute_update',
  'application_approved',
  'application_rejected',
  'worker_selected',
  'revision_requested',
  'payout_sent',
  'payout_failed',
  'penalty_notice',
  'kyc_required',
  'new_job_in_category',
  'message_received',
  'job_expiring',
  'support_reply'
);

create type public.email_status as enum (
  'queued', 'sending', 'sent', 'failed', 'bounced', 'complained', 'cancelled'
);

create type public.background_job_status as enum (
  'queued', 'running', 'succeeded', 'failed', 'dead'
);

-- ============================================================================
-- Generic helpers
-- ============================================================================

-- Every table with an `updated_at` column attaches this.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Attached to append-only tables (ledger, audit log, job events). Revoking
-- UPDATE/DELETE from a role is not enough — the service-role key bypasses
-- grants, and these tables are exactly the ones a bug must not be able to
-- rewrite.
create or replace function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'table %.% is append-only; % is not permitted',
    tg_table_schema, tg_table_name, tg_op;
end;
$$;

comment on function public.set_updated_at is 'Trigger: stamps updated_at on every UPDATE.';
comment on function public.forbid_mutation is 'Trigger: rejects UPDATE/DELETE on append-only tables.';
